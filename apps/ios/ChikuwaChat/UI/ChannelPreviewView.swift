import SwiftUI

/// The preview's join bar (M27): an archived channel offers no 「参加する」 (the server answers 409 channel_archived).
enum PreviewJoin {
    /// In place of the button when the channel is archived.
    static let archivedNote = "アーカイブされたチャンネルです (読むだけ)"

    static func canJoin(_ channel: ChannelOut) -> Bool { !channel.archived }

    /// M89 (MEMBERSHIP.md §5 5.): the panel in place of the messages when the workspace turned the preview off (the
    /// errors.json `preview_disabled` words).
    static let refusedTitle = "参加するとメッセージを読めます"

    /// Whether the preview shows the panel: the workspace's 「参加前にチャンネルの中を見られる」 is off, or the server
    /// answered 403 preview_disabled (it changed while this device was offline).
    static func refused(previewBeforeJoin: Bool, refusedByServer: Bool) -> Bool { !previewBeforeJoin || refusedByServer }

    /// A refusal of the preview by the server.
    static func isRefusal(_ error: Error) -> Bool {
        if case ApiError.api(403, "preview_disabled", _) = error { return true }
        return false
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
    /// Oldest first, as the timeline shows them.
    @State private var messages: [MessageState] = []
    @State private var hasMore = false
    @State private var loaded = false
    @State private var loading = false
    @State private var loadingOlder = false
    @State private var failure: String?
    @State private var thread: ThreadTarget?
    @State private var joining = false
    /// The rows are the context of `focusMessageId`, not the newest page.
    @State private var showingContext = false
    /// M89: the server answered 403 preview_disabled (the setting changed while offline); cleared when it turns on.
    @State private var refusedByServer = false
    /// The channel as `GET /channels/{id}` answers it, for the panel's member count when the list gave none.
    @State private var fetched: ChannelOut?
    @AppStorage(Timeline.groupingKey) private var grouping = false  // M47

    private static let margin: CGFloat = 12
    private static let pageSize = 50
    private var channel: ChannelState? { controller.store.channel(channelId) }
    private var previewBeforeJoin: Bool { controller.store.workspaceSettings.previewBeforeJoin }
    private var refused: Bool { PreviewJoin.refused(previewBeforeJoin: previewBeforeJoin, refusedByServer: refusedByServer) }

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
        .onAppear {
            guard !loaded && !loading && !refused else { return }
            loading = true
            Task {
                await load()
                loading = false
            }
        }
        // M89: the setting changed while open: off, the rows go and the panel shows; on, the page loads.
        .onChange(of: previewBeforeJoin) { _, on in
            if on {
                refusedByServer = false
                guard !loading else { return }
                loading = true
                Task {
                    await load()
                    loading = false
                }
            } else {
                clearRows()
            }
        }
        .sheet(item: $thread) { target in
            PreviewThreadView(controller: controller, parentId: target.id, parent: messages.first { $0.id == target.id })
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

    private func clearRows() {
        messages = []
        hasMore = false
        loaded = false
        failure = nil
        showingContext = false
        thread = nil
    }

    private var preview: some View {
        VStack(spacing: 0) {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    if hasMore {
                        Group {
                            if loadingOlder {
                                ProgressView().controlSize(.small)
                            } else {
                                Button("以前のメッセージを読み込む") { Task { await loadOlder() } }
                            }
                        }
                        .frame(maxWidth: .infinity)
                        .font(.footnote)
                        .padding(.vertical, 8)
                    } else if loaded, let channel {
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
            .defaultScrollAnchor(showingContext ? .center : .bottom)
            .overlay(alignment: .bottomTrailing) {
                if showingContext {
                    Button { Task { await load(latest: true) } } label: {
                        Label("最新へ", systemImage: "arrow.down").font(.footnote.bold())
                            .padding(.horizontal, 12).padding(.vertical, 8).background(.thinMaterial, in: Capsule())
                    }
                    .padding(12)
                }
            }
            .overlay {
                if let failure {
                    ContentUnavailableView {
                        Label("読み込めませんでした", systemImage: "exclamationmark.triangle")
                    } description: {
                        Text(failure)
                    } actions: {
                        Button("再読み込み") { Task { await load() } }
                    }
                } else if !loaded {
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

    /// The newest page, or (a permalink, unless `latest`) the messages around the linked one.
    private func load(latest: Bool = false) async {
        guard let api = controller.api, previewBeforeJoin else { return }
        failure = nil
        do {
            if let focusMessageId, !latest {
                messages = Self.rows(try await api.messageContext(focusMessageId))
                hasMore = true
                showingContext = true
            } else {
                let page = try await api.history(channelId: channelId, beforeSeq: nil, limit: Self.pageSize)
                messages = Self.rows(page.messages)
                hasMore = page.hasMore
                showingContext = false
            }
            loaded = true
        } catch where PreviewJoin.isRefusal(error) {
            clearRows()
            refusedByServer = true
        } catch {
            failure = controller.describe(error)
        }
    }

    private func loadOlder() async {
        guard let api = controller.api, let oldest = messages.first?.seq else { return }
        loadingOlder = true
        defer { loadingOlder = false }
        do {
            let page = try await api.history(channelId: channelId, beforeSeq: oldest, limit: Self.pageSize)
            messages = Self.rows(page.messages) + messages
            hasMore = page.hasMore
        } catch where PreviewJoin.isRefusal(error) {
            clearRows()
            refusedByServer = true
        } catch { controller.error = controller.describe(error) }
    }

    /// A page as the timeline shows it: oldest first, deleted ones left out.
    static func rows(_ page: [MessageOut]) -> [MessageState] {
        page.map(MessageState.init).filter { !$0.deleted }.sorted { ($0.seq ?? 0) < ($1.seq ?? 0) }
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

/// A thread read from a channel's preview (M27): the parent and its replies, fetched when opened, and no input.
struct PreviewThreadView: View {
    @Bindable var controller: AppController
    let parentId: String
    var parent: MessageState?
    @State private var replies: [MessageState] = []
    @State private var fetchedParent: MessageState?
    @State private var loaded = false
    @Environment(\.dismiss) private var dismiss

    private static let margin: CGFloat = 16

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    if let parent = parent ?? fetchedParent {
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
            .task { await load() }
        }
    }

    private func load() async {
        guard let api = controller.api else { return }
        do {
            if parent == nil { fetchedParent = MessageState(try await api.message(id: parentId)) }
            replies = ChannelPreviewView.rows(try await api.replies(messageId: parentId))
        } catch {
            if Task.isCancelled { return }
            controller.error = controller.describe(error)
        }
        loaded = true
    }
}
