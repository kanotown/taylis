import SwiftUI

/// Followed threads (THREADS.md §5): newest reply first, an all / unread filter; a row opens the thread, its
/// conversation's name (and the long-press menu's 「チャンネルを開く」) the conversation at the thread's parent.
struct ThreadsListView: View {
    /// The sidebar selection value that shows this view instead of a channel.
    static let selectionId = "threads"

    @Bindable var controller: AppController
    @State private var target: Target?
    /// 「すべて既読にする」 asks first, as the home's does (THREADS.md §3.2).
    @State private var confirmReadAll = false
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
    /// Something to read: the badge's count, or a held row (the badge may lag behind the list).
    private var hasUnread: Bool { store.threadSummary.unreadCount > 0 || !store.threadList(filter: "unread").isEmpty }

    /// A reply under a card: its thread, landing on the reply (the thread view scrolls to and marks the focused reply).
    /// The focus comes first, as an activity reply's does; the thread opens at its usual place when it cannot be had.
    private func openReply(_ reply: MessageState, of entry: ThreadEntry) {
        let open = Target(id: entry.parent.id, channelId: entry.state.channelId)
        Task {
            _ = await controller.revealMessage(id: reply.id, channelId: reply.channelId, parentId: entry.parent.id)
            target = open
        }
    }

    var body: some View {
        List {
            Section {
                Picker("表示", selection: Binding(get: { store.threadsFilter }, set: { value in store.selectThreadsFilter(value); Task { await controller.engine?.loadThreads(filter: value) } })) {
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
                    ThreadRowView(entry: entry, controller: controller, onOpenThread: openThread, onOpenConversation: openConversation,
                                  onOpenReply: { reply in openReply(reply, of: entry) })
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
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                // THREADS.md §3.2: every followed thread read (the activity's own 「すべて既読にする」 leaves threads alone).
                Button { confirmReadAll = true } label: {
                    Label("すべて既読にする", systemImage: "checkmark.circle")
                        .labelStyle(.titleOnly)
                }
                .disabled(!hasUnread)
            }
        }
        .alert("スレッドをすべて既読にしますか？", isPresented: $confirmReadAll) {
            Button("既読にする") { Task { await controller.markAllThreadsRead() } }
            Button("キャンセル", role: .cancel) {}
        } message: {
            Text("フォロー中のスレッドの返信をすべて既読にします。")
        }
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
    /// A reply under the parent (THREADS.md §5); nil opens the thread.
    var onOpenReply: ((MessageState) -> Void)?

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
                if let card = ThreadCardRules.replies(entry, me: store.me?.id, isBlocked: store.isBlocked), !card.replies.isEmpty {
                    let openReply = onOpenReply ?? { _ in onOpenThread() }
                    VStack(alignment: .leading, spacing: 4) {
                        if card.more > 0 {
                            Button(action: onOpenThread) {
                                Text("他 \(card.more) 件の返信").font(.caption).fontWeight(.medium).foregroundStyle(.tint)
                            }
                            .buttonStyle(.borderless)
                        }
                        ForEach(card.replies, id: \.message.id) { reply in
                            ThreadPreviewReplyView(reply: reply, controller: controller)
                                .contentShape(Rectangle())
                                .onTapGesture { openReply(reply.message) }
                                .accessibilityAction { openReply(reply.message) }
                        }
                    }
                    .padding(.leading, 8)
                    .overlay(alignment: .leading) { Rectangle().fill(Color.secondary.opacity(0.25)).frame(width: 2) }
                    .padding(.top, 4)
                }
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

/// The replies part of a threads-list card (THREADS.md §5).
enum ThreadCardRules {
    struct Reply {
        let message: MessageState
        /// Someone else's reply after my read position in the thread (marked as the thread view marks it).
        let unread: Bool
    }

    /// nil when the server sent no previews (the card is the parent only, as before); `more` is 「他 n 件の返信」.
    static func replies(_ entry: ThreadEntry, me: String?, isBlocked: (String) -> Bool) -> (replies: [Reply], more: Int)? {
        guard let latest = entry.latestReplies else { return nil }
        // Someone blocked after the list came: their replies leave the card at once (the server leaves them out too).
        let shown = latest.filter { !$0.deleted && !isBlocked($0.senderId) }.map {
            Reply(message: $0, unread: $0.senderId != me && ($0.seq ?? 0) > entry.state.lastReadSeq)
        }
        return (shown, max(0, entry.state.replyCount - shown.count))
    }
}

/// A reply under a card: compact, the body in the message renderer cut to about four lines.
struct ThreadPreviewReplyView: View {
    let reply: ThreadCardRules.Reply
    @Bindable var controller: AppController

    private var store: Store { controller.store }

    var body: some View {
        let message = reply.message
        let name = store.users[message.senderId]?.displayName ?? "…"
        HStack(alignment: .top, spacing: 8) {
            AvatarView(id: message.senderId, name: name, size: 22)
            VStack(alignment: .leading, spacing: 1) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(name).font(.footnote).fontWeight(reply.unread ? .bold : .medium).lineLimit(1)
                    Text(Timeline.timeLabel(message.createdAt)).font(.caption2).foregroundStyle(.secondary)
                    if reply.unread {
                        Circle().fill(Color.accentColor).frame(width: 7, height: 7).accessibilityLabel(Text("未読"))
                    }
                }
                if message.body.isEmpty {
                    Text(Timeline.excerpt(message.body, attachments: message.attachments, users: store.users, groups: store.groups))
                        .font(.footnote).foregroundStyle(.secondary)
                } else {
                    MessageBodyView(text: message.body, users: store.users, groups: store.groups, internalBase: controller.api?.baseUrl,
                                    customEmoji: store.customEmoji, emojiImages: store.emojiImages, emojiAnimations: store.emojiAnimations,
                                    onNeedEmojiImage: { controller.loadEmojiImage($0) })
                        .font(.footnote)
                        .frame(maxHeight: 84, alignment: .top)
                        .clipped()
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
        .accessibilityHint(Text("\(name) さんの返信、スレッドで開く"))
    }
}
