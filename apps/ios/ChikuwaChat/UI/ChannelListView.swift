import SwiftUI

struct ChannelListView: View {
    @Bindable var controller: AppController
    @Binding var selection: String?
    @AppStorage("sidebar.unreadOnly") private var unreadOnly = false

    private var channels: [ChannelState] { Array(controller.store.channels.values) }
    /// The unread filter keeps the open conversation so the selection never disappears.
    private func keep(_ channel: ChannelState) -> Bool { !unreadOnly || channel.id == selection || channel.showsUnread }
    private var mine: [ChannelState] { channels.filter { $0.isMember && !$0.channel.isDm && !$0.channel.archived && keep($0) }.sorted { ($0.channel.name ?? "") < ($1.channel.name ?? "") } }
    private var dms: [ChannelState] { channels.filter { $0.isMember && $0.channel.isDm && keep($0) }.sorted { ($0.channel.lastMessageAt ?? "") > ($1.channel.lastMessageAt ?? "") } }
    private var browse: [ChannelState] { unreadOnly ? [] : channels.filter { !$0.isMember && $0.channel.type == "public" && !$0.channel.archived }.sorted { ($0.channel.name ?? "") < ($1.channel.name ?? "") } }

    var body: some View {
        List(selection: $selection) {
            Section {
                Picker("表示", selection: $unreadOnly) {
                    Text("すべて").tag(false)
                    Text("未読").tag(true)
                }
                .pickerStyle(.segmented)
                .listRowBackground(Color.clear)
            }
            Section {
                threadsRow
            }
            Section("チャンネル") {
                ForEach(mine) { row($0) }
                if mine.isEmpty { hint(unreadOnly ? "未読のチャンネルはありません。" : "参加中のチャンネルはありません。＋ から作成できます。") }
            }
            Section("ダイレクトメッセージ") {
                ForEach(dms) { row($0) }
                if dms.isEmpty { hint(unreadOnly ? "未読の DM はありません。" : "＋ の「ダイレクトメッセージ」から相手を選べます。") }
            }
            if !browse.isEmpty {
                Section("参加できるチャンネル") {
                    ForEach(browse) { channel in
                        Button { join(channel.id) } label: {
                            HStack(spacing: 12) {
                                ChannelGlyph(channel: channel.channel)
                                Text(rowTitle(channel)).foregroundStyle(.primary)
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

    /// 「スレッド」 (THREADS.md §5): followed threads with unread replies; red when one mentions me.
    private var threadsRow: some View {
        let summary = controller.store.threadSummary
        let active = selection == ThreadsListView.selectionId
        let unread = summary.unreadCount > 0 && !active
        return NavigationLink(value: ThreadsListView.selectionId) {
            HStack(spacing: 12) {
                Image(systemName: "bubble.left.and.text.bubble.right")
                    .font(.body).foregroundStyle(.secondary).frame(width: 28)
                Text("スレッド").fontWeight(unread ? .semibold : .regular)
                Spacer()
                if unread {
                    Text("\(summary.unreadCount)")
                        .font(.caption2).bold().foregroundStyle(.white)
                        .padding(.horizontal, 7).padding(.vertical, 2)
                        .background(summary.mentionCount > 0 ? Color.red : Color.accentColor, in: Capsule())
                }
            }
            .padding(.vertical, 2)
        }
    }

    /// The glyph already says "#", so rows show the bare channel name.
    private func rowTitle(_ channel: ChannelState) -> String {
        let title = channelTitle(channel, store: controller.store)
        return channel.channel.isDm ? title : String(title.drop(while: { $0 == "#" }))
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
        let muted = channel.isMuted
        let unread = channel.showsUnread && channel.id != selection
        let store = controller.store
        return NavigationLink(value: channel.id) {
            HStack(spacing: 12) {
                if channel.channel.isDm {
                    let other = (channel.channel.dmUserIds ?? []).first { $0 != store.me?.id } ?? store.me?.id ?? channel.id
                    AvatarView(id: other, name: store.users[other]?.displayName ?? store.me?.displayName ?? "?", presence: store.presenceOf(other))
                } else {
                    ChannelGlyph(channel: channel.channel)
                }
                VStack(alignment: .leading, spacing: 1) {
                    Text(rowTitle(channel)).fontWeight(unread ? .semibold : .regular).lineLimit(1)
                    if !channel.channel.isDm, let topic = channel.channel.topic, !topic.isEmpty {
                        Text(topic).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
                Spacer()
                if muted { Image(systemName: "bell.slash").font(.caption).foregroundStyle(.secondary) }
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
            .opacity(muted && !unread ? 0.6 : 1)
        }
    }
}
