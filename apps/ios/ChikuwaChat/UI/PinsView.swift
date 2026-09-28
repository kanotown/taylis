import SwiftUI

/// Messages pinned in a channel (M11c), most recently pinned first; a row reveals the message.
struct PinsView: View {
    @Bindable var controller: AppController
    let channelId: String
    let onOpen: (MessageOut) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var pins: [MessageOut]?

    var body: some View {
        NavigationStack {
            List {
                if let pins {
                    if pins.isEmpty {
                        Text("ピン留めされたメッセージはありません。メッセージを長押しして「チャンネルにピン留め」を選ぶと、ここに集まります。")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                    ForEach(pins) { message in
                        Button { onOpen(message) } label: { MessageCardView(message: message, controller: controller) }.buttonStyle(.plain)
                    }
                } else {
                    ProgressView()
                }
            }
            .listStyle(.plain)
            .navigationTitle("ピン留め")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("閉じる") { dismiss() } } }
            .task(id: controller.engine?.status) {
                guard let api = controller.api else { return }
                do { pins = try await api.listPins(channelId: channelId) } catch { controller.error = controller.describe(error) }
            }
        }
    }
}

/// A compact message card shared by the pins sheet and the saved list.
struct MessageCardView: View {
    let message: MessageOut
    @Bindable var controller: AppController

    var body: some View {
        let store = controller.store
        let sender = store.users[message.senderId]?.displayName ?? "?"
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                AvatarView(id: message.senderId, name: sender, size: 20)
                Text(sender).bold()
                Text(store.channel(message.channelId).map { channelTitle($0, store: store) } ?? "?").foregroundStyle(.secondary).lineLimit(1)
                Spacer()
                Text(Timeline.timeLabel(message.createdAt)).foregroundStyle(.secondary)
            }
            .font(.caption)
            Text(message.body.isEmpty ? message.attachments.map(\.filename).joined(separator: ", ") : Mentions.decode(message.body, users: store.users, groups: store.groups))
                .lineLimit(4)
        }
        .padding(.vertical, 2)
        // The whole card is the tap target: a plain-style button hits only what is drawn, so the blank end of a short
        // pinned or saved message did nothing.
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }
}
