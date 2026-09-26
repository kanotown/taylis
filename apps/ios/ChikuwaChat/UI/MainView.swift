import SwiftUI

struct MainView: View {
    @Bindable var controller: AppController
    @State private var selection: String?
    @State private var sheet: Sheet?
    @State private var pendingThreadId: String?

    enum Sheet: Identifiable {
        case newDm, newChannel, search, settings, browse
        var id: Int { switch self { case .newDm: 0; case .newChannel: 1; case .search: 2; case .settings: 3; case .browse: 4 } }
    }

    private var status: EngineStatus { controller.engine?.status ?? .idle }

    var body: some View {
        NavigationSplitView {
            ChannelListView(controller: controller, selection: $selection)
                .navigationTitle("ChikuwaChat")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        Button { sheet = .settings } label: {
                            if let me = controller.store.me {
                                AvatarView(id: me.id, name: me.displayName, size: 30)
                            } else {
                                Image(systemName: "person.crop.circle")
                            }
                        }
                        .accessibilityLabel("設定")
                    }
                    ToolbarItem(placement: .topBarLeading) { StatusBadge(status: status) }
                    ToolbarItem(placement: .topBarTrailing) { Button("検索", systemImage: "magnifyingglass") { sheet = .search } }
                    ToolbarItem(placement: .topBarTrailing) {
                        Menu {
                            Button("ダイレクトメッセージ", systemImage: "person.2") { sheet = .newDm }
                            Button("チャンネルを作成", systemImage: "number") { sheet = .newChannel }
                            Button("チャンネルを探す", systemImage: "safari") { sheet = .browse }
                        } label: { Image(systemName: "plus") }
                        .accessibilityLabel("新規")
                    }
                }
        } detail: {
            if selection == ThreadsListView.selectionId {
                ThreadsListView(controller: controller)
            } else if selection == SavedView.selectionId {
                SavedView(controller: controller) { message in
                    Task {
                        if await controller.revealMessage(message) {
                            selection = message.channelId
                            pendingThreadId = message.parentId
                        }
                    }
                }
            } else if selection == MentionsView.selectionId {
                MentionsView(controller: controller) { message in
                    Task {
                        if await controller.revealMessage(message) {
                            selection = message.channelId
                            pendingThreadId = message.parentId
                        }
                    }
                }
            } else if selection == DraftsView.selectionId {
                DraftsView(controller: controller) { channelId, parentId in
                    selection = channelId
                    pendingThreadId = parentId
                }
            } else if let id = selection, let channel = controller.store.channel(id) {
                // View state resets; conversation drafts live in the persistent Store.
                ChannelView(controller: controller, channelId: channel.id, pendingThreadId: $pendingThreadId).id(channel.id)
            } else {
                ContentUnavailableView("チャンネルを選択してください", systemImage: "bubble.left.and.bubble.right",
                                       description: Text("左のリストからチャンネルや相手を選びます。"))
            }
        }
        .safeAreaInset(edge: .top, spacing: 0) { ConnectionBanner(status: status) }
        .overlay(alignment: .bottom) { ErrorToast(controller: controller) }
        .sheet(item: $sheet) { which in
            switch which {
            case .newDm: NewDmView(controller: controller) { id in selection = id }
            case .newChannel: NewChannelView(controller: controller) { id in selection = id }
            case .search: SearchView(controller: controller) { message in
                Task {
                    if await controller.revealMessage(message) {
                        selection = message.channelId
                        pendingThreadId = message.parentId
                        sheet = nil
                    }
                }
            }
            case .settings: SettingsView(controller: controller)
            case .browse: ChannelBrowserView(controller: controller) { id in selection = id }
            }
        }
        .onChange(of: selection) { _, id in
            if controller.messageFocus?.channelId != id { controller.messageFocus = nil }
            if id == ThreadsListView.selectionId || id == SavedView.selectionId || id == MentionsView.selectionId || id == DraftsView.selectionId {
                controller.engine?.currentChannelId = nil // no conversation is open: notifications for all channels
            } else if let id, let engine = controller.engine { Task { await engine.openChannel(id) } }
        }
        .onReceive(NotificationCenter.default.publisher(for: .chikuwaOpenChannel)) { note in
            if let id = note.userInfo?["id"] as? String { selection = id }
        }
        .onChange(of: PushCenter.shared.pendingChannelId, initial: true) { _, id in
            // A tapped notification opens its channel once the store knows it (after bootstrap / catch_up).
            if let id, controller.store.channel(id) != nil {
                selection = id
                PushCenter.shared.pendingChannelId = nil
            }
        }
    }
}

struct StatusBadge: View {
    let status: EngineStatus

    var body: some View {
        switch status {
        case .online: Label("接続中", systemImage: "circle.fill").foregroundStyle(.green).labelStyle(.iconOnly).imageScale(.small)
        case .connecting: ProgressView().controlSize(.small)
        case .offline: Label("再接続中", systemImage: "circle").foregroundStyle(.orange).labelStyle(.iconOnly).imageScale(.small)
        default: EmptyView()
        }
    }
}

/// Thin strip at the top while the socket is not live; nothing when online.
struct ConnectionBanner: View {
    let status: EngineStatus

    var body: some View {
        switch status {
        case .connecting: strip("サーバに接続しています…", color: .blue)
        case .offline: strip("オフラインです。再接続を待っています…", color: .orange)
        default: EmptyView()
        }
    }

    private func strip(_ text: String, color: Color) -> some View {
        Text(text)
            .font(.caption)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 4)
            .background(color)
            .foregroundStyle(.white)
    }
}

/// Transient error banner for actions that fail after login (edit, upload, settings…).
struct ErrorToast: View {
    @Bindable var controller: AppController

    var body: some View {
        if let message = controller.error {
            HStack(spacing: 12) {
                Text(message).font(.footnote)
                Spacer(minLength: 0)
                Button { controller.error = nil } label: { Image(systemName: "xmark") }
                    .accessibilityLabel("閉じる")
            }
            .padding(12)
            .foregroundStyle(.white)
            .background(Color.red.opacity(0.92), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .padding()
            .task(id: message) {
                try? await Task.sleep(for: .seconds(6))
                if controller.error == message { controller.error = nil }
            }
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

/// Muted when the level is "none" or a timed mute is active.
@MainActor
func isMuted(_ channel: ChannelState) -> Bool { channel.isMuted }
