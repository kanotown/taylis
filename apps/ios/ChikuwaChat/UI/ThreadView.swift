import SwiftUI

/// One thread: the parent, its replies (oldest first) and a composer that posts with parent_id.
/// The toolbar follows / unfollows the thread; replies that were shown advance the thread read position.
struct ThreadView: View {
    @Bindable var controller: AppController
    let channelId: String
    let parentId: String
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase

    @State private var positioned = false
    @State private var atBottom = true
    @State private var visibleFrames: [String: CGRect] = [:]
    @State private var viewportHeight: CGFloat = 0
    private var entry: ThreadEntry? { controller.store.threads[parentId] }
    private var parent: MessageState? {
        controller.store.message(channelId, id: parentId)
            ?? entry.map { MessageState($0.parent) }
            ?? controller.messageFocus?.context.first { $0.id == parentId }
    }
    private var replies: [MessageState] { controller.store.replies(channelId, parentId: parentId) }
    /// 「新しい返信」 sits before the first reply from someone else past my read position.
    private var firstUnreadId: String? {
        guard let state = entry?.state, let me = controller.store.me?.id else { return nil }
        return replies.first { ($0.seq ?? 0) > state.lastReadSeq && $0.senderId != me }?.id
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                ScrollViewReader { proxy in
                    GeometryReader { viewport in
                        ScrollView {
                            LazyVStack(alignment: .leading, spacing: 12) {
                                if let parent {
                                    MessageRow(message: parent, controller: controller)
                                    Text(replies.isEmpty ? "返信はまだありません" : "\(replies.count) 件の返信")
                                        .font(.caption).foregroundStyle(.secondary)
                                    Divider()
                                    ForEach(replies) { reply in
                                        if reply.id == firstUnreadId { NewRepliesDivider() }
                                        MessageRow(message: reply, controller: controller)
                                            .id(reply.id)
                                            .background(GeometryReader { geometry in
                                                Color.clear.preference(key: VisibleReplyFrames.self,
                                                                       value: [reply.id: geometry.frame(in: .named("threadViewport"))])
                                            })
                                    }
                                } else {
                                    Text("メッセージが見つかりません").foregroundStyle(.secondary)
                                }
                                Color.clear.frame(height: 1).id("bottom")
                                    .onAppear { atBottom = true }
                                    .onDisappear { atBottom = false }
                            }
                            .padding()
                        }
                        .coordinateSpace(name: "threadViewport")
                        .onPreferenceChange(VisibleReplyFrames.self) { frames in
                            visibleFrames = frames
                            viewportHeight = viewport.size.height
                            markRead()
                        }
                    }
                    .defaultScrollAnchor(.bottom)
                    .scrollDismissesKeyboard(.interactively)
                    .onChange(of: replies.last?.id) { _, _ in
                        let mine = replies.last.map { $0.senderId == controller.store.me?.id && $0.pending } ?? false
                        if positioned && (atBottom || mine) && controller.messageFocus?.parentId != parentId {
                            withAnimation(.easeOut(duration: 0.25)) { proxy.scrollTo("bottom", anchor: .bottom) }
                        }
                    }
                    .onChange(of: scenePhase) { _, _ in markRead() }
                    .onChange(of: controller.engine?.status) { _, _ in markRead() }
                    .task(id: replies.count) {
                        guard !positioned, !replies.isEmpty else { return }
                        await Task.yield()
                        if let focus = controller.messageFocus, focus.parentId == parentId {
                            proxy.scrollTo(focus.messageId, anchor: .center)
                        } else { proxy.scrollTo("bottom", anchor: .bottom) }
                        positioned = true
                    }
                }
                if let channel = controller.store.channel(channelId), channel.isMember, !channel.channel.archived, parent != nil {
                    ComposerView(channelId: channelId, parentId: parentId, users: Array(controller.store.users.values), placeholder: "スレッドに返信", controller: controller) { body, attachmentIds in
                        Task { await controller.engine?.send(channelId, body: body, parentId: parentId, attachmentIds: attachmentIds) }
                    }
                }
            }
            .navigationTitle("スレッド")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("閉じる") { dismiss() } }
                if let state = entry?.state, controller.store.channel(channelId)?.isMember == true {
                    ToolbarItem(placement: .primaryAction) {
                        Button {
                            Task { await controller.engine?.setThreadFollow(parentId, following: !state.following) }
                        } label: {
                            Label(state.following ? "フォロー中" : "フォロー", systemImage: state.following ? "bell.fill" : "bell")
                                .labelStyle(.titleAndIcon)
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                        .tint(state.following ? Color.accentColor : .secondary)
                        .accessibilityLabel(state.following ? "スレッドのフォローを外す" : "スレッドをフォロー")
                    }
                }
            }
            .task(id: controller.engine?.status) { await controller.engine?.loadReplies(channelId, parentId: parentId) }
            // THREADS.md §5: my relation to the thread (follow flag, read position) is fetched once per thread.
            .task(id: "\(parentId):\(controller.engine?.status.rawValue ?? "")") {
                guard entry == nil, let parent, let out = MessageOut(parent) else { return }
                await controller.engine?.loadThreadState(parentId, parent: out)
            }
        }
    }

    /// Read position = the newest reply fully shown (never just "opened"), like the timeline.
    private func markRead() {
        guard scenePhase == .active, viewportHeight > 0 else { return }
        let seq = replies.compactMap { reply -> Int? in
            guard let frame = visibleFrames[reply.id], frame.maxY > 0, frame.minY < viewportHeight,
                  (frame.minY >= 0 && frame.maxY <= viewportHeight || frame.height > viewportHeight) else { return nil }
            return reply.seq
        }.max()
        if let seq { controller.engine?.markThreadRead(parentId, seq: seq) }
    }
}

private struct NewRepliesDivider: View {
    var body: some View {
        HStack(spacing: 8) {
            Rectangle().fill(Color.red.opacity(0.6)).frame(height: 1)
            Text("新しい返信").font(.caption2).bold().foregroundStyle(.red)
        }
    }
}

private struct VisibleReplyFrames: PreferenceKey {
    static let defaultValue: [String: CGRect] = [:]
    static func reduce(value: inout [String: CGRect], nextValue: () -> [String: CGRect]) {
        value.merge(nextValue(), uniquingKeysWith: { _, latest in latest })
    }
}

struct ThreadTarget: Identifiable, Hashable {
    let id: String
}
