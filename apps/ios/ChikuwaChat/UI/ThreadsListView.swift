import SwiftUI

/// Followed threads (THREADS.md §5): newest reply first, an all / unread filter; a row opens the thread, its
/// conversation's name (and the long-press menu's 「チャンネルを開く」) the conversation at the thread's parent.
struct ThreadsListView: View {
    /// The sidebar selection value that shows this view instead of a channel.
    static let selectionId = "threads"

    @Bindable var controller: AppController
    @State private var target: Target?
    /// M34: inside the activity tab, whose title it keeps.
    var embedded = false
    /// The conversation of a row, its parent message revealed (MainView: on this tab's stack); nil shows no link.
    var onOpenConversation: ((ThreadEntry) -> Void)?

    private struct Target: Identifiable, Hashable {
        let id: String
        let channelId: String
    }

    private var store: Store { controller.store }
    private var rows: [ThreadEntry] { store.threadList() }

    var body: some View {
        List {
            Section {
                Picker("表示", selection: Binding(get: { store.threadsFilter }, set: { value in Task { await controller.engine?.loadThreads(filter: value) } })) {
                    Text("すべて").tag("all")
                    Text("未読").tag("unread")
                }
                .pickerStyle(.segmented)
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
            }
            if rows.isEmpty {
                ContentUnavailableView(
                    !store.threadsLoaded ? "読み込んでいます…" : store.threadsFilter == "unread" ? "未読のスレッドはありません" : "フォロー中のスレッドはありません",
                    systemImage: "bubble.left.and.text.bubble.right",
                    description: Text("自分が投稿・返信・メンションされたスレッドはここに集まります。"))
                .listRowSeparator(.hidden)
            } else {
                ForEach(rows) { entry in
                    let openThread = { target = Target(id: entry.parent.id, channelId: entry.state.channelId) }
                    let openConversation = onOpenConversation.map { open in { open(entry) } }
                    ThreadRowView(entry: entry, controller: controller, onOpenThread: openThread, onOpenConversation: openConversation)
                        .contextMenu {
                            if let openConversation {
                                Button(action: openConversation) {
                                    let isDm = store.channel(entry.state.channelId)?.channel.isDm ?? false
                                    Label(isDm ? "会話を開く" : "チャンネルを開く", systemImage: "bubble.left.and.bubble.right")
                                }
                            }
                            Button(action: openThread) { Label("スレッドを開く", systemImage: "bubble.left.and.text.bubble.right") }
                        }
                }
                if store.threadsHasMore {
                    Button("さらに表示") { Task { await controller.engine?.loadThreads(filter: store.threadsFilter, more: true) } }
                        .frame(maxWidth: .infinity)
                }
            }
        }
        .listStyle(.plain)
        .navigationTitle(embedded ? "アクティビティ" : "スレッド")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: controller.engine?.status) { await controller.engine?.loadThreads(filter: store.threadsFilter) }
        .refreshable { await controller.engine?.loadThreads(filter: store.threadsFilter) }
        // M29: pushed, like a thread opened from its channel.
        .navigationDestination(item: $target) { target in ThreadView(controller: controller, channelId: target.channelId, parentId: target.id) }
    }
}

/// A followed thread's card: the card opens the thread; the conversation's name over it is a link to the conversation.
struct ThreadRowView: View {
    let entry: ThreadEntry
    @Bindable var controller: AppController
    let onOpenThread: () -> Void
    var onOpenConversation: (() -> Void)?

    private var store: Store { controller.store }

    var body: some View {
        let parent = entry.parent
        let state = entry.state
        let unread = state.unreadCount > 0
        let author = store.users[parent.senderId]?.displayName ?? "…"
        let last = state.lastReplyAt ?? parent.createdAt
        HStack(alignment: .top, spacing: 12) {
            AvatarView(id: parent.senderId, name: author, size: 36)
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline) {
                    if let channel = store.channel(state.channelId) {
                        let title = channelTitle(channel, store: store)
                        if let onOpenConversation {
                            // Its own button (a child's tap wins over the card's): the conversation, not the thread.
                            Button(action: onOpenConversation) {
                                Text(title).font(.caption).fontWeight(.medium).foregroundStyle(.tint).lineLimit(1)
                            }
                            .buttonStyle(.borderless)
                            .accessibilityLabel(Text("\(title) を開く"))
                        } else {
                            Text(title).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                        }
                    }
                    Spacer()
                    Text(Timeline.timeLabel(last)).font(.caption).foregroundStyle(.secondary)
                }
                VStack(alignment: .leading, spacing: 3) {
                    Text(author).font(.subheadline).fontWeight(unread ? .semibold : .medium).lineLimit(1)
                    CustomEmoji.excerpt(excerpt(parent), controller: controller).font(.subheadline).foregroundStyle(unread ? .primary : .secondary).lineLimit(2)
                    HStack(spacing: 6) {
                        Text("\(state.replyCount) 件の返信").font(.caption).fontWeight(unread ? .semibold : .regular)
                            .foregroundStyle(unread ? Color.accentColor : .secondary)
                        if unread { Text("· 未読 \(state.unreadCount) 件").font(.caption).foregroundStyle(.secondary) }
                        Spacer()
                        if unread {
                            Text(state.mentionCount > 0 ? "@\(state.mentionCount)" : "\(state.unreadCount)")
                                .font(.caption2).bold().foregroundStyle(.white)
                                .padding(.horizontal, 7).padding(.vertical, 2)
                                .background(state.mentionCount > 0 ? Color.red : Color.accentColor, in: Capsule())
                        }
                    }
                }
                // The rest of the card is one button for VoiceOver, as the whole row was before the link.
                .accessibilityElement(children: .combine)
                .accessibilityAddTraits(.isButton)
                .accessibilityAction { onOpenThread() }
            }
        }
        .padding(.vertical, 4)
        .contentShape(Rectangle())
        .onTapGesture(perform: onOpenThread)
    }

    /// One-line preview: mentions as names, light markdown stripped (DATA_MODEL.md 本文の形式).
    private func excerpt(_ message: MessageOut) -> String {
        Timeline.excerpt(message.body, attachments: message.attachments, users: store.users, groups: store.groups)
    }
}
