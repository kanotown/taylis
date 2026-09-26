import SwiftUI

/// 「チャンネルを探す」 (M11h): every public channel plus my private ones, with member counts; join, leave or create.
struct ChannelBrowserView: View {
    @Bindable var controller: AppController
    let onOpen: (String) -> Void
    /// Rows to show before the first load (previews and snapshot tests).
    var initial: [ChannelOut]? = nil
    @Environment(\.dismiss) private var dismiss
    @State private var listed: [ChannelOut]?
    @State private var query = ""
    @State private var busy: String?
    @State private var showCreate = false

    private var rows: [ChannelOut] {
        let needle = query.trimmingCharacters(in: .whitespaces).lowercased()
        return (listed ?? []).filter { channel in
            needle.isEmpty || (channel.name ?? "").lowercased().contains(needle)
                || (channel.topic ?? "").lowercased().contains(needle) || (channel.purpose ?? "").lowercased().contains(needle)
        }.sorted { a, b in
            if a.archived != b.archived { return !a.archived }
            if (a.memberCount ?? 0) != (b.memberCount ?? 0) { return (a.memberCount ?? 0) > (b.memberCount ?? 0) }
            return (a.name ?? "") < (b.name ?? "")
        }
    }

    var body: some View {
        NavigationStack {
            List {
                if let listed {
                    if rows.isEmpty { Text(listed.isEmpty ? "チャンネルはありません" : "見つかりません").foregroundStyle(.secondary) }
                    ForEach(rows) { channel in row(channel) }
                } else {
                    ProgressView()
                }
            }
            .listStyle(.plain)
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "名前やトピックで絞り込む")
            .navigationTitle("チャンネルを探す")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("閉じる") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("作成", systemImage: "plus") { showCreate = true } }
            }
            .task { if listed == nil { listed = initial }; await load() }
            .refreshable { await load() }
            .sheet(isPresented: $showCreate) {
                NewChannelView(controller: controller) { id in onOpen(id); dismiss() }
            }
        }
    }

    private func isMember(_ channel: ChannelOut) -> Bool {
        controller.store.channel(channel.id)?.isMember ?? (channel.membership != nil)
    }

    private func row(_ channel: ChannelOut) -> some View {
        let mine = isMember(channel)
        return HStack(spacing: 12) {
            Image(systemName: channel.type == "private" ? "lock" : "number").foregroundStyle(.secondary).frame(width: 24)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(channel.name ?? "").fontWeight(.medium)
                    if channel.archived {
                        Text("アーカイブ済み").font(.caption2).foregroundStyle(.secondary)
                    } else if mine {
                        Text("参加中").font(.caption2).foregroundStyle(Color.accentColor)
                    }
                }
                HStack(spacing: 4) {
                    Image(systemName: "person.2").font(.caption2)
                    Text("\(channel.memberCount ?? 0) 人")
                    if let text = channel.purpose ?? channel.topic, !text.isEmpty { Text("· \(text)").lineLimit(1) }
                }
                .font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            if !channel.archived {
                if mine {
                    Button("退出") { Task { await leave(channel) } }
                        .buttonStyle(.bordered).controlSize(.small).disabled(busy == channel.id)
                } else {
                    Button("参加") { Task { await join(channel) } }
                        .buttonStyle(.borderedProminent).controlSize(.small).disabled(busy == channel.id)
                }
            }
        }
        .contentShape(Rectangle())
        .onTapGesture { if mine { onOpen(channel.id); dismiss() } }
        .opacity(channel.archived ? 0.6 : 1)
    }

    private func load() async {
        guard let api = controller.api else { return }
        do {
            listed = try await api.channels(includePublic: true).filter { $0.type == "public" || $0.type == "private" }
        } catch { controller.error = controller.describe(error) }
    }

    private func join(_ channel: ChannelOut) async {
        guard let api = controller.api else { return }
        busy = channel.id
        defer { busy = nil }
        do {
            let joined = try await api.joinChannel(id: channel.id)
            controller.store.upsertChannel(joined, isMember: true)
            onOpen(channel.id)
            dismiss()
        } catch { controller.error = controller.describe(error) }
    }

    private func leave(_ channel: ChannelOut) async {
        busy = channel.id
        if await controller.leaveChannel(channel.id) { await load() }
        busy = nil
    }
}
