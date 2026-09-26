import SwiftUI

struct MainView: View {
    @Bindable var controller: AppController
    @State private var selection: String?
    @State private var sheet: Sheet?

    enum Sheet: Identifiable {
        case newDm, newChannel
        var id: Int { self == .newDm ? 0 : 1 }
    }

    var body: some View {
        NavigationSplitView {
            ChannelListView(controller: controller, selection: $selection)
                .navigationTitle(controller.store.me?.displayName ?? "ChikuwaChat")
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        Menu {
                            Button("ダイレクトメッセージ", systemImage: "person.2") { sheet = .newDm }
                            Button("チャンネルを作成", systemImage: "number") { sheet = .newChannel }
                            Divider()
                            Button("ログアウト", systemImage: "rectangle.portrait.and.arrow.right", role: .destructive) {
                                Task { await controller.logout() }
                            }
                        } label: { Image(systemName: "plus") }
                    }
                    ToolbarItem(placement: .topBarLeading) { StatusBadge(status: controller.engine?.status ?? .idle) }
                }
        } detail: {
            if let id = selection, let channel = controller.store.channel(id) {
                ChannelView(controller: controller, channelId: channel.id)
            } else {
                Text("チャンネルを選択してください").foregroundStyle(.secondary)
            }
        }
        .sheet(item: $sheet) { which in
            switch which {
            case .newDm: NewDmView(controller: controller) { id in selection = id }
            case .newChannel: NewChannelView(controller: controller) { id in selection = id }
            }
        }
        .onChange(of: selection) { _, id in
            if let id, let engine = controller.engine { Task { await engine.openChannel(id) } }
        }
    }
}

struct StatusBadge: View {
    let status: EngineStatus

    var body: some View {
        switch status {
        case .online: Label("接続中", systemImage: "circle.fill").foregroundStyle(.green).labelStyle(.iconOnly)
        case .connecting: ProgressView().controlSize(.small)
        case .offline: Label("再接続中", systemImage: "circle").foregroundStyle(.orange).labelStyle(.iconOnly)
        default: EmptyView()
        }
    }
}

@MainActor
func channelTitle(_ channel: ChannelState, store: Store) -> String {
    if !channel.channel.isDm { return "#\(channel.channel.name ?? "")" }
    let others = (channel.channel.dmUserIds ?? []).filter { $0 != store.me?.id }
    if others.isEmpty { return "自分へのメモ" }
    return others.map { store.users[$0]?.displayName ?? "…" }.joined(separator: ", ")
}
