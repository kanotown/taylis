import SwiftUI

/// M15e: 「重要」 / 「緊急」 above a message and in the composer.
struct PriorityLabelView: View {
    let priority: String

    var body: some View {
        let urgent = priority == "urgent"
        Label(urgent ? "緊急" : "重要", systemImage: urgent ? "exclamationmark.triangle.fill" : "info.circle.fill")
            .font(.caption2.bold())
            .foregroundStyle(urgent ? Color.red : Color.accentColor)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background((urgent ? Color.red : Color.accentColor).opacity(0.12), in: RoundedRectangle(cornerRadius: 4))
    }
}

/// M15e: 「確認しました」 for readers, and who has acknowledged so far.
struct AckBarView: View {
    let message: MessageState
    @Bindable var controller: AppController

    var body: some View {
        let store = controller.store
        let mine = store.me.map { me in message.acks.contains { $0.userId == me.id } } ?? false
        let own = store.me?.id == message.senderId
        let names = message.acks.map { store.users[$0.userId]?.displayName ?? "?" }
        HStack(spacing: 8) {
            if !own {
                Button { Task { await controller.toggleAck(message) } } label: {
                    Label(mine ? "確認済み" : "確認しました", systemImage: "checkmark.circle")
                }
                .buttonStyle(.bordered)
                .tint(mine ? Color.accentColor : Color.secondary)
                .controlSize(.mini)
            }
            if names.isEmpty {
                Text("まだ誰も確認していません").font(.caption).foregroundStyle(.secondary)
            } else {
                Menu {
                    ForEach(Array(names.enumerated()), id: \.offset) { _, name in Text(name) }
                } label: {
                    Text("\(names.count) 人が確認").font(.caption).foregroundStyle(.secondary)
                }
            }
        }
        .padding(.top, 2)
    }
}
