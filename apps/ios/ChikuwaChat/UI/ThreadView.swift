import SwiftUI

/// One thread: the parent, its replies (oldest first) and a composer that posts with parent_id.
struct ThreadView: View {
    @Bindable var controller: AppController
    let channelId: String
    let parentId: String
    @Environment(\.dismiss) private var dismiss

    @State private var positioned = false
    @State private var atBottom = true
    private var parent: MessageState? { controller.store.message(channelId, id: parentId) ?? controller.messageFocus?.context.first { $0.id == parentId } }
    private var replies: [MessageState] { controller.store.replies(channelId, parentId: parentId) }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 12) {
                            if let parent {
                                MessageRow(message: parent, controller: controller)
                                Text(replies.isEmpty ? "返信はまだありません" : "\(replies.count) 件の返信")
                                    .font(.caption).foregroundStyle(.secondary)
                                Divider()
                                ForEach(replies) { reply in MessageRow(message: reply, controller: controller).id(reply.id) }
                            } else {
                                Text("メッセージが見つかりません").foregroundStyle(.secondary)
                            }
                            Color.clear.frame(height: 1).id("bottom")
                                .onAppear { atBottom = true }
                                .onDisappear { atBottom = false }
                        }
                        .padding()
                    }
                    .defaultScrollAnchor(.bottom)
                    .scrollDismissesKeyboard(.interactively)
                    .onChange(of: replies.last?.id) { _, _ in
                        let mine = replies.last.map { $0.senderId == controller.store.me?.id && $0.pending } ?? false
                        if positioned && (atBottom || mine) && controller.messageFocus?.parentId != parentId {
                            withAnimation(.easeOut(duration: 0.25)) { proxy.scrollTo("bottom", anchor: .bottom) }
                        }
                    }
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
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("閉じる") { dismiss() } } }
            .task(id: controller.engine?.status) { await controller.engine?.loadReplies(channelId, parentId: parentId) }
        }
    }
}

struct ThreadTarget: Identifiable, Hashable {
    let id: String
}
