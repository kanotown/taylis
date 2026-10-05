import SwiftUI

/// L8 (TIMES_FEED.md §7): 「Times フィード」, the timeline posts of the times I follow, newest at the top (read from the top
/// down: not an upside-down list like a conversation). A row is a conversation row with its times' name over it and a dot
/// while it is past that times' read position; opening the feed reads nothing (§4). A tap shows the message in its
/// channel, 「N 件の返信」 its thread; a long press has the conversation's actions.
struct TimesFeedView: View {
    /// The home stack's list value that shows this view.
    static let selectionId = "times-feed"
    /// §7's empty text, its first sentence as the title.
    static var emptyTitle: String { tr("参加している times がありません") }
    static var emptyText: String { tr("チャンネル一覧から times に参加すると、ここに新しい投稿が並びます") }

    @Bindable var controller: AppController
    /// The message in its channel (the caller reveals it).
    let onOpen: (MessageOut) -> Void
    /// A channel (a row's times name, my own times).
    let onOpenChannel: (String) -> Void

    @State private var thread: FeedThread?
    @State private var messageSheet: MessageSheet?
    @State private var opened = false
    @State private var confirmRead = false
    @State private var making = false

    private static let margin: CGFloat = 12

    struct FeedThread: Identifiable, Hashable {
        let channelId: String
        let parentId: String
        var id: String { parentId }
    }

    private var model: TimesFeedModel { controller.timesFeed }
    private var store: Store { controller.store }
    private var status: EngineStatus { controller.engine?.status ?? .idle }
    private var meId: String? { store.me?.id }

    /// The feed's channels now: when one goes (left, muted), its rows go.
    private var feedChannelKey: String {
        store.channels.values.filter { TimesFeedList.isFeedChannel($0) }.map(\.id).sorted().joined(separator: ",")
    }

    /// My own times, when I am in it.
    private var myTimesId: String? {
        guard let meId else { return nil }
        return store.channels.values.first { $0.isMember && $0.channel.timesOwnerId == meId }?.id
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                if status == .offline && model.loaded {
                    Text("オフラインです。最後に読み込んだ投稿を表示しています。")
                        .font(.footnote).foregroundStyle(.secondary)
                        .padding(.horizontal, 16).padding(.vertical, 8)
                }
                ForEach(model.list.items) { message in
                    row(message)
                        .onAppear {
                            if message.id == model.list.items.last?.id { Task { await controller.loadMoreTimesFeed() } }
                        }
                    Divider().padding(.leading, Self.margin + 46)
                }
                if model.loadingMore {
                    ProgressView().controlSize(.small).frame(maxWidth: .infinity).padding(.vertical, 12)
                }
                if model.loaded, let failure = model.failure {
                    VStack(spacing: 8) {
                        Text(failure).font(.footnote).foregroundStyle(.red).multilineTextAlignment(.center)
                        Button("もう一度") { Task { await controller.refreshTimesFeed() } }.buttonStyle(.bordered)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
                }
            }
            .containerRelativeFrame(.horizontal) // never wider than the screen (ChannelView)
        }
        .overlay { overlay }
        .refreshable { await controller.refreshTimesFeed() }
        .navigationTitle("Times フィード")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .topBarTrailing) { menu } }
        .alert("Times をすべて既読にしますか？", isPresented: $confirmRead) {
            Button("既読にする") { Task { await controller.markTimesRead() } }
            Button("キャンセル", role: .cancel) {}
        } message: {
            Text("フィードに出ている times（ミュートしていないもの）の未読がなくなります。")
        }
        .navigationDestination(item: $thread) { target in ThreadView(controller: controller, channelId: target.channelId, parentId: target.parentId) }
        .messageSheets(controller, sheet: $messageSheet, openThread: { message in openThread(channelId: message.channelId, id: message.id, parentId: message.parentId) })
        .task {
            // §5: the first page is read when the feed opens (not again when a thread over it closes).
            model.visible = true
            guard !opened else { return }
            opened = true
            await controller.refreshTimesFeed()
        }
        .onChange(of: status) { old, new in
            // §5: after a reconnect, the first page again (events were lost while the connection was down).
            if opened && new == .online && old != .online { Task { await controller.refreshTimesFeed() } }
        }
        .onChange(of: feedChannelKey, initial: true) { _, _ in model.prune(channel: { store.channel($0) }) }
    }

    /// The thread over the feed (review #8): ThreadView finds a feed row's parent in the feed; the parent of a reply
    /// also sent to the channel is fetched first when nothing holds it.
    private func openThread(channelId: String, id: String, parentId: String?) {
        let target = FeedThread(channelId: channelId, parentId: parentId ?? id)
        guard parentId != nil else { thread = target; return }
        Task {
            await controller.loadTimesFeedParent(channelId: target.channelId, parentId: target.parentId)
            thread = target
        }
    }

    @ViewBuilder
    private var overlay: some View {
        if model.list.items.isEmpty {
            if !model.loaded && model.loading {
                ProgressView()
            } else if !model.loaded, let failure = model.failure {
                ContentUnavailableView {
                    Label("読み込めませんでした", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(failure)
                } actions: {
                    Button("再読み込み") { Task { await controller.refreshTimesFeed() } }
                }
            } else if model.loaded {
                if feedChannelKey.isEmpty {
                    ContentUnavailableView(Self.emptyTitle, systemImage: "newspaper", description: Text(Self.emptyText))
                } else {
                    ContentUnavailableView("まだ投稿がありません", systemImage: "newspaper",
                                           description: Text("参加している times に投稿があると、ここに新しい順に並びます。"))
                }
            }
        }
    }

    private var menu: some View {
        Menu {
            Button("すべて既読にする", systemImage: "checkmark.circle") { confirmRead = true }
            if let mine = myTimesId {
                Button("自分の times に書く", systemImage: "square.and.pencil") {
                    controller.composerFocus = mine
                    onOpenChannel(mine)
                }
            } else if !controller.isGuest {
                Button("自分の times を作る", systemImage: "plus") {
                    guard !making else { return }
                    making = true
                    Task {
                        if let id = await controller.ensureTimes() {
                            controller.composerFocus = id
                            onOpenChannel(id)
                        }
                        making = false
                    }
                }
            }
        } label: {
            Image(systemName: "ellipsis")
        }
        .accessibilityLabel("その他")
    }

    private func row(_ message: MessageOut) -> some View {
        let channel = store.channel(message.channelId)
        let isNew = TimesFeedList.isNew(message, channel: channel, meId: meId)
        return VStack(alignment: .leading, spacing: 0) {
            // The times' name, over the sender's (aligned with it): a tap opens the times.
            Button { onOpenChannel(message.channelId) } label: {
                Label(channel?.channel.name ?? "?", systemImage: "number")
                    .labelStyle(TimesNameLabelStyle())
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            .buttonStyle(.plain)
            .padding(.leading, Self.margin + 46)
            .padding(.top, 8)
            .accessibilityLabel("\(channel?.channel.name ?? "") を開く")
            MessageRow(message: MessageState(message), controller: controller, margin: Self.margin,
                       highlighted: messageSheet?.kind == .actions && messageSheet?.message.id == message.id,
                       onOpenThread: { openThread(channelId: message.channelId, id: message.id, parentId: message.parentId) },
                       present: { messageSheet = $0 },
                       onTap: { onOpen(message) })
                .overlay(alignment: .topLeading) {
                    if isNew {
                        Circle().fill(Color.accentColor).frame(width: 7, height: 7)
                            .padding(.leading, 3).padding(.top, 20)
                            .accessibilityLabel("新しい投稿")
                    }
                }
        }
    }
}

/// The times' name: a small # and the name, close together.
private struct TimesNameLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 3) {
            configuration.icon.imageScale(.small)
            configuration.title
        }
    }
}
