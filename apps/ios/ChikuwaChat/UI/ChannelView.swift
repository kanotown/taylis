import SwiftUI

struct ChannelView: View {
    @Bindable var controller: AppController
    let channelId: String
    @State private var draft = ""
    @State private var showAddMember = false

    private var channel: ChannelState? { controller.store.channel(channelId) }
    private var messages: [MessageState] { controller.store.messages(channelId) }

    /// Viewing the newest messages marks them read (SYNC_PROTOCOL.md §10; debounced in the engine).
    private func markRead() {
        guard let channel, UIApplication.shared.applicationState == .active else { return }
        controller.engine?.markRead(channelId, seq: channel.lastSeq)
    }

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        if let channel, channel.hasOlder, channel.syncedSeq != nil {
                            Button("以前のメッセージを読み込む") { Task { await controller.engine?.loadOlder(channelId) } }
                                .frame(maxWidth: .infinity)
                                .font(.footnote)
                        }
                        ForEach(messages) { message in
                            MessageRow(message: message, controller: controller).id(message.id)
                        }
                        Color.clear.frame(height: 1).id("bottom")
                    }
                    .padding()
                }
                .onChange(of: messages.last?.id) { _, _ in
                    withAnimation { proxy.scrollTo("bottom", anchor: .bottom) }
                    markRead()
                }
                .onChange(of: channel?.lastSeq) { _, _ in markRead() }
                .onAppear { proxy.scrollTo("bottom", anchor: .bottom); markRead() }
            }
            if let channel {
                if !channel.isMember {
                    Button("参加する") {
                        Task {
                            if let api = controller.api, let joined = try? await api.joinChannel(id: channelId) {
                                controller.store.upsertChannel(joined, isMember: true)
                                await controller.engine?.openChannel(channelId)
                            }
                        }
                    }
                    .buttonStyle(.borderedProminent).padding()
                } else if channel.channel.archived {
                    Text("アーカイブ済みのチャンネルです").font(.footnote).foregroundStyle(.secondary).padding()
                } else {
                    ComposerView(text: $draft, users: Array(controller.store.users.values)) { body in
                        Task { await controller.engine?.send(channelId, body: body) }
                    }
                }
            }
        }
        .navigationTitle(channel.map { channelTitle($0, store: controller.store) } ?? "")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let channel, channel.isMember, !channel.channel.isDm, !channel.channel.archived {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("メンバーを追加", systemImage: "person.badge.plus") { showAddMember = true }
                }
            }
        }
        .sheet(isPresented: $showAddMember) { AddMemberView(controller: controller, channelId: channelId) }
    }
}

let reactionPalette = ["👍", "❤️", "😂", "🎉", "👀", "✅"]

struct MessageRow: View {
    let message: MessageState
    @Bindable var controller: AppController
    @State private var editing = false
    @State private var confirmingDelete = false

    private var store: Store { controller.store }
    private var engine: SyncEngine? { controller.engine }
    private var isMine: Bool { store.me?.id == message.senderId }

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(store.users[message.senderId]?.displayName ?? (message.pending ? store.me?.displayName ?? "" : "?")).bold()
                Text(formatTime(message.createdAt)).font(.caption).foregroundStyle(.secondary)
                if message.editedAt != nil { Text("(編集済み)").font(.caption).foregroundStyle(.secondary) }
            }
            MessageBodyView(text: message.body, users: store.users)
            if !message.reactions.isEmpty {
                HStack(spacing: 6) {
                    ForEach(message.reactions, id: \.emoji) { reaction in
                        let mine = store.me.map { reaction.userIds.contains($0.id) } ?? false
                        Button { Task { await controller.toggleReaction(message, emoji: reaction.emoji) } } label: {
                            Text("\(reaction.emoji) \(reaction.count)").font(.caption)
                        }
                        .buttonStyle(.bordered)
                        .tint(mine ? Color.accentColor : Color.secondary)
                        .controlSize(.mini)
                    }
                }
                .padding(.top, 2)
            }
            if message.failed {
                HStack {
                    Text("送信失敗").font(.caption).foregroundStyle(.red)
                    Button("再送") { Task { await engine?.retryFailed() } }.font(.caption)
                    Button("破棄", role: .destructive) { if let key = message.clientMsgId { engine?.discardFailed(key) } }.font(.caption)
                }
            }
        }
        .opacity(message.pending && !message.failed ? 0.6 : 1)
        .contentShape(Rectangle())
        .contextMenu {
            if !message.pending {
                ForEach(reactionPalette, id: \.self) { emoji in
                    Button(emoji) { Task { await controller.toggleReaction(message, emoji: emoji) } }
                }
                if isMine { Button("編集", systemImage: "pencil") { editing = true } }
                if isMine || controller.isAdmin { Button("削除", systemImage: "trash", role: .destructive) { confirmingDelete = true } }
            }
        }
        .sheet(isPresented: $editing) {
            EditMessageView(initial: Mentions.decode(message.body, users: store.users)) { body in
                Task { await controller.editMessage(message.id, body: Mentions.encode(body, users: store.users.values)) }
            }
        }
        .confirmationDialog("メッセージを削除しますか？", isPresented: $confirmingDelete, titleVisibility: .visible) {
            Button("削除", role: .destructive) { Task { await controller.deleteMessage(message.id) } }
        }
    }

    private func formatTime(_ iso: String) -> String {
        guard let date = parseIsoDate(iso) else { return "送信中…" }
        return date.formatted(date: .omitted, time: .shortened)
    }
}

struct EditMessageView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var text: String
    let onSave: (String) -> Void

    init(initial: String, onSave: @escaping (String) -> Void) {
        _text = State(initialValue: initial)
        self.onSave = onSave
    }

    private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        NavigationStack {
            TextEditor(text: $text)
                .padding()
                .navigationTitle("メッセージを編集")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("キャンセル") { dismiss() } }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("保存") { onSave(trimmed); dismiss() }.disabled(trimmed.isEmpty)
                    }
                }
        }
    }
}

/// The server sends ISO 8601 with microseconds; ISO8601DateFormatter only understands milliseconds.
func parseIsoDate(_ iso: String) -> Date? {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = formatter.date(from: iso) { return date }
    let truncated = iso.replacingOccurrences(of: #"(\.\d{3})\d+"#, with: "$1", options: .regularExpression)
    if let date = formatter.date(from: truncated) { return date }
    formatter.formatOptions = [.withInternetDateTime]
    return formatter.date(from: iso)
}

struct ComposerView: View {
    @Binding var text: String
    let users: [UserPublic]
    let onSend: (String) -> Void

    private var candidates: [Mentions.Candidate] {
        guard let query = Mentions.query(text) else { return [] }
        return Mentions.candidates(query, users: users)
    }

    private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        VStack(spacing: 0) {
            if !candidates.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack {
                        ForEach(candidates) { candidate in
                            Button("@\(candidate.username)  \(candidate.label)") { text = Mentions.complete(text, username: candidate.username) }
                                .buttonStyle(.bordered)
                                .controlSize(.small)
                        }
                    }
                    .padding(.horizontal)
                }
                .padding(.vertical, 4)
            }
            HStack(alignment: .bottom) {
                TextField("メッセージを入力", text: $text, axis: .vertical)
                    .lineLimit(1...5)
                    .textFieldStyle(.roundedBorder)
                Button("送信", systemImage: "paperplane.fill") {
                    let body = Mentions.encode(trimmed, users: users)
                    guard !body.isEmpty else { return }
                    text = ""
                    onSend(body)
                }
                .labelStyle(.iconOnly)
                .disabled(trimmed.isEmpty)
            }
            .padding()
        }
        .background(.bar)
    }
}
