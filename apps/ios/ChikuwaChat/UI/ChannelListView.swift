import SwiftUI

struct ChannelListView: View {
    @Bindable var controller: AppController
    @Binding var selection: String?

    private var channels: [ChannelState] { Array(controller.store.channels.values) }
    private var mine: [ChannelState] { channels.filter { $0.isMember && !$0.channel.isDm && !$0.channel.archived }.sorted { ($0.channel.name ?? "") < ($1.channel.name ?? "") } }
    private var dms: [ChannelState] { channels.filter { $0.isMember && $0.channel.isDm }.sorted { ($0.channel.lastMessageAt ?? "") > ($1.channel.lastMessageAt ?? "") } }
    private var browse: [ChannelState] { channels.filter { !$0.isMember && $0.channel.type == "public" && !$0.channel.archived }.sorted { ($0.channel.name ?? "") < ($1.channel.name ?? "") } }

    var body: some View {
        List(selection: $selection) {
            Section("チャンネル") { ForEach(mine) { row($0) } }
            Section("ダイレクトメッセージ") { ForEach(dms) { row($0) } }
            if !browse.isEmpty {
                Section("参加できるチャンネル") {
                    ForEach(browse) { channel in
                        Button {
                            Task {
                                if let api = controller.api, let joined = try? await api.joinChannel(id: channel.id) {
                                    controller.store.upsertChannel(joined, isMember: true)
                                    selection = joined.id
                                }
                            }
                        } label: {
                            Label(channelTitle(channel, store: controller.store), systemImage: "plus.circle")
                        }
                    }
                }
            }
        }
        .listStyle(.sidebar)
    }

    private func row(_ channel: ChannelState) -> some View {
        NavigationLink(value: channel.id) {
            HStack {
                Text(channelTitle(channel, store: controller.store))
                Spacer()
                if channel.hasUnread && channel.id != selection {
                    Circle().fill(.blue).frame(width: 8, height: 8)
                }
            }
        }
    }
}
