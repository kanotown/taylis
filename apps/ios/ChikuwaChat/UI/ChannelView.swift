import SwiftUI

struct ChannelView: View {
    @Bindable var controller: AppController
    let channelId: String
    @State private var draft = ""
    @State private var showAddMember = false

    private var channel: ChannelState? { controller.store.channel(channelId) }
    private var messages: [MessageState] { controller.store.messages(channelId) }

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
                            MessageRow(message: message, store: controller.store, engine: controller.engine).id(message.id)
                        }
                        Color.clear.frame(height: 1).id("bottom")
                    }
                    .padding()
                }
                .onChange(of: messages.last?.id) { _, _ in
                    withAnimation { proxy.scrollTo("bottom", anchor: .bottom) }
                    controller.engine?.markSeen(channelId)
                }
                .onAppear { proxy.scrollTo("bottom", anchor: .bottom) }
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
                    ComposerView(text: $draft) { body in
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

struct MessageRow: View {
    let message: MessageState
    let store: Store
    let engine: SyncEngine?

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(store.users[message.senderId]?.displayName ?? (message.pending ? store.me?.displayName ?? "" : "?")).bold()
                Text(formatTime(message.createdAt)).font(.caption).foregroundStyle(.secondary)
                if message.editedAt != nil { Text("(編集済み)").font(.caption).foregroundStyle(.secondary) }
            }
            MessageBodyView(text: message.body, users: store.users)
            if message.failed {
                HStack {
                    Text("送信失敗").font(.caption).foregroundStyle(.red)
                    Button("再送") { Task { await engine?.retryFailed() } }.font(.caption)
                    Button("破棄", role: .destructive) { if let key = message.clientMsgId { engine?.discardFailed(key) } }.font(.caption)
                }
            }
        }
        .opacity(message.pending && !message.failed ? 0.6 : 1)
    }

    private func formatTime(_ iso: String) -> String {
        guard let date = parseIsoDate(iso) else { return "送信中…" }
        return date.formatted(date: .omitted, time: .shortened)
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
    let onSend: (String) -> Void

    var body: some View {
        HStack(alignment: .bottom) {
            TextField("メッセージを入力", text: $text, axis: .vertical)
                .lineLimit(1...5)
                .textFieldStyle(.roundedBorder)
            Button("送信", systemImage: "paperplane.fill") {
                let body = text.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !body.isEmpty else { return }
                text = ""
                onSend(body)
            }
            .labelStyle(.iconOnly)
            .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .padding()
        .background(.bar)
    }
}
