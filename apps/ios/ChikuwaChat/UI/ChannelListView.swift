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
            Section("チャンネル") {
                ForEach(mine) { row($0) }
                if mine.isEmpty { hint("参加中のチャンネルはありません。＋ から作成できます。") }
            }
            Section("ダイレクトメッセージ") {
                ForEach(dms) { row($0) }
                if dms.isEmpty { hint("＋ の「ダイレクトメッセージ」から相手を選べます。") }
            }
            if !browse.isEmpty {
                Section("参加できるチャンネル") {
                    ForEach(browse) { channel in
                        Button { join(channel.id) } label: {
                            HStack(spacing: 12) {
                                ChannelGlyph(channel: channel.channel)
                                Text(channelTitle(channel, store: controller.store)).foregroundStyle(.primary)
                                Spacer()
                                Text("参加").font(.footnote).foregroundStyle(Color.accentColor)
                            }
                        }
                    }
                }
            }
        }
        .listStyle(.sidebar)
    }

    private func hint(_ text: String) -> some View {
        Text(text).font(.footnote).foregroundStyle(.secondary)
    }

    private func join(_ id: String) {
        Task {
            guard let api = controller.api else { return }
            do {
                let joined = try await api.joinChannel(id: id)
                controller.store.upsertChannel(joined, isMember: true)
                selection = joined.id
            } catch { controller.error = controller.describe(error) }
        }
    }

    private func row(_ channel: ChannelState) -> some View {
        let badge = channel.badgeContribution
        let unread = channel.hasUnread && channel.id != selection
        let store = controller.store
        return NavigationLink(value: channel.id) {
            HStack(spacing: 12) {
                if channel.channel.isDm {
                    let other = (channel.channel.dmUserIds ?? []).first { $0 != store.me?.id } ?? store.me?.id ?? channel.id
                    AvatarView(id: other, name: store.users[other]?.displayName ?? store.me?.displayName ?? "?")
                } else {
                    ChannelGlyph(channel: channel.channel)
                }
                VStack(alignment: .leading, spacing: 1) {
                    Text(channelTitle(channel, store: store)).fontWeight(unread ? .semibold : .regular).lineLimit(1)
                    if !channel.channel.isDm, let topic = channel.channel.topic, !topic.isEmpty {
                        Text(topic).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
                Spacer()
                if isMuted(channel) { Image(systemName: "bell.slash").font(.caption).foregroundStyle(.secondary) }
                if unread && badge > 0 {
                    Text("\(badge)")
                        .font(.caption2).bold().foregroundStyle(.white)
                        .padding(.horizontal, 7).padding(.vertical, 2)
                        .background(Color.accentColor, in: Capsule())
                } else if unread {
                    Circle().fill(Color.accentColor).frame(width: 8, height: 8)
                }
            }
            .padding(.vertical, 2)
        }
    }
}
