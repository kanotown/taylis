import SwiftUI

/// 「別のチャンネルに共有」(M13c): pick a conversation, add a comment, post the quote and permalink there.
struct ShareMessageSheet: View {
    @Bindable var controller: AppController
    let message: MessageState
    @Environment(\.dismiss) private var dismiss
    @State private var targetId: String?
    @State private var comment = ""
    @State private var busy = false

    private var targets: [ChannelState] {
        controller.store.channels.values
            .filter { $0.isMember && !$0.channel.archived && $0.id != message.channelId }
            .sorted { label($0) < label($1) }
    }

    private func label(_ state: ChannelState) -> String {
        if state.channel.type == "dm" || state.channel.type == "group_dm" {
            let me = controller.store.me?.id
            let names = (state.channel.dmUserIds ?? []).filter { $0 != me }.compactMap { controller.store.users[$0]?.displayName }
            return names.isEmpty ? tr("自分") : names.joined(separator: ", ")
        }
        return (state.channel.type == "private" ? "🔒" : "#") + (state.channel.name ?? "")
    }

    var body: some View {
        NavigationStack {
            Form {
                Section { TextField("コメント（任意）", text: $comment, axis: .vertical).lineLimit(1...3) }
                Section("共有先") {
                    ForEach(targets) { state in
                        Button {
                            targetId = state.id
                        } label: {
                            HStack {
                                Text(label(state)).foregroundStyle(.primary)
                                Spacer()
                                if targetId == state.id { Image(systemName: "checkmark").foregroundStyle(Color.accentColor) }
                            }
                        }
                    }
                    if targets.isEmpty { Text("共有先になる会話がありません").foregroundStyle(.secondary) }
                }
            }
            .navigationTitle("別のチャンネルに共有")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("キャンセル") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("共有") {
                        guard let targetId else { return }
                        Task {
                            busy = true
                            if await controller.shareMessage(message, to: targetId, comment: comment) { dismiss() }
                            busy = false
                        }
                    }
                    .disabled(busy || targetId == nil)
                }
            }
            .onAppear { if targetId == nil { targetId = targets.first?.id } }
        }
    }
}
