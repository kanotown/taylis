import SwiftUI

struct MainView: View {
    @Bindable var controller: AppController
    @State private var selection: String?
    /// A permalink into a channel I have not joined (M27): the preview opens around this message.
    @State private var previewMessageId: String?
    /// The lists a selection can name besides a channel.
    private static let listIds: Set<String> = [DraftsView.selectionId, FilesView.selectionId, MentionsView.selectionId,
                                               RemindersView.selectionId, SavedView.selectionId, ThreadsListView.selectionId]
    /// The selected channel left the store (I left it or was removed, it went private while previewed, a bootstrap
    /// dropped it): the detail showed 「チャンネルを選択してください」 with the id kept (audit 2026-09-29).
    private var selectionGone: Bool {
        guard let id = selection, !Self.listIds.contains(id) else { return false }
        return controller.store.channel(id) == nil
    }
    @State private var sheet: Sheet?
    @State private var pendingThreadId: String?

    enum Sheet: Identifiable {
        case newDm, newChannel, search, settings, browse, directory, workspaces, newSection
        var id: Int { switch self { case .newDm: 0; case .newChannel: 1; case .search: 2; case .settings: 3; case .browse: 4; case .directory: 5; case .workspaces: 6; case .newSection: 7 } }
    }

    private var status: EngineStatus { controller.engine?.status ?? .idle }
    /// A tapped notification's conversation once the store knows it; a new DM or channel only arrives with the
    /// bootstrap after the tap, so this is watched rather than checked once.
    private var pendingChannelReady: String? {
        guard let id = PushCenter.shared.pendingChannelId, controller.store.channel(id) != nil else { return nil }
        return id
    }

    var body: some View {
        NavigationSplitView {
            ChannelListView(controller: controller, selection: $selection)
                .navigationTitle(controller.workspaceName)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    // M16c: the workspace on screen; with two or more, a tap opens the switcher.
                    ToolbarItem(placement: .principal) { WorkspaceTitle(controller: controller) { sheet = .workspaces } }
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
                            Button("メンバー", systemImage: "person.3") { sheet = .directory }
                            if !controller.isGuest {
                                Button("チャンネルを作成", systemImage: "number") { sheet = .newChannel }
                                Button("チャンネルを探す", systemImage: "safari") { sheet = .browse }
                            }
                            Button("新しいセクション", systemImage: "folder.badge.plus") { sheet = .newSection }
                            Divider()
                            Button("すべて既読にする", systemImage: "checkmark.circle") { Task { await controller.markAllRead() } }
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
            } else if selection == RemindersView.selectionId {
                RemindersView(controller: controller) { row in Task { await controller.openPermalink(row.messageId) } }
            } else if selection == FilesView.selectionId {
                FilesView(controller: controller) { messageId, channelId, parentId in
                    Task {
                        if await controller.revealMessage(id: messageId, channelId: channelId, parentId: parentId) {
                            selection = channelId
                            pendingThreadId = parentId
                        }
                    }
                }
            } else if selection == DraftsView.selectionId {
                DraftsView(controller: controller) { channelId, parentId in
                    selection = channelId
                    pendingThreadId = parentId
                }
            } else if let id = selection, let channel = controller.store.channel(id) {
                if !channel.isMember && channel.channel.type == "public" && !controller.isGuest {
                    // M27: a public channel I have not joined is read before joining (Slack); joining shows the channel.
                    ChannelPreviewView(controller: controller, channelId: channel.id, focusMessageId: previewMessageId).id("preview " + channel.id)
                } else {
                    // View state resets; conversation drafts live in the persistent Store.
                    ChannelView(controller: controller, channelId: channel.id, pendingThreadId: $pendingThreadId).id(channel.id)
                }
            } else {
                ContentUnavailableView("チャンネルを選択してください", systemImage: "bubble.left.and.bubble.right",
                                       description: Text("左のリストからチャンネルや相手を選びます。"))
            }
        }
        .safeAreaInset(edge: .top, spacing: 0) { ConnectionBanner(status: status) }
        .overlay(alignment: .bottom) {
            VStack(spacing: 6) {
                NoticeToast(controller: controller)
                ErrorToast(controller: controller)
            }
        }
        .sheet(item: $sheet) { which in
            switch which {
            case .newDm: NewDmView(controller: controller) { id in selection = id }
            case .directory: DirectoryView(controller: controller) { id in selection = id }
            case .newChannel: NewChannelView(controller: controller) { id in selection = id }
            case .search: SearchView(controller: controller)
            case .settings: SettingsView(controller: controller)
            case .browse: ChannelBrowserView(controller: controller) { id in selection = id }
            case .workspaces: WorkspaceSwitcherSheet(controller: controller)
            case .newSection: SectionFormView(controller: controller, section: nil)
            }
        }
        .onChange(of: selection) { _, id in
            if controller.messageFocus?.channelId != id { controller.messageFocus = nil }
            if id == nil || id == ThreadsListView.selectionId || id == SavedView.selectionId || id == MentionsView.selectionId || id == DraftsView.selectionId || id == FilesView.selectionId || id == RemindersView.selectionId {
                controller.engine?.closeConversation() // back to the list (iPhone) or another view: no conversation is open
            } else if let id, let engine = controller.engine { Task { await engine.openChannel(id) } }
        }
        .onReceive(NotificationCenter.default.publisher(for: .chikuwaOpenChannel)) { note in
            if let id = note.userInfo?["id"] as? String {
                if sheet == .search { sheet = nil } // a conversation opened from a search result's profile or link
                previewMessageId = note.userInfo?["messageId"] as? String
                selection = id
                if let parentId = note.userInfo?["parentId"] as? String { pendingThreadId = parentId }
            }
        }
        .onChange(of: selection) { _, _ in if previewMessageId != nil && selection == nil { previewMessageId = nil } }
        .onChange(of: selectionGone) { _, gone in if gone { selection = nil } }
        .onChange(of: pendingChannelReady, initial: true) { _, id in
            // A tapped notification opens its channel once the store knows it (after bootstrap / catch_up).
            if let id {
                selection = id
                if let parentId = PushCenter.shared.pendingParentId { pendingThreadId = parentId } // a reply's thread (M28d)
                PushCenter.shared.pendingChannelId = nil
                PushCenter.shared.pendingParentId = nil
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

/// Thin strip at the top while the socket stays down. A reconnect that finishes within `grace` (launch, return
/// from the background) shows nothing: the strip would only flash and push the screen down and back. Once shown,
/// it follows the status until the socket is live again (same 2 s on every client).
struct ConnectionBanner: View {
    let status: EngineStatus
    static let grace: Duration = .seconds(2)
    @State private var shown: EngineStatus?

    var body: some View {
        Group {
            switch shown {
            case .connecting: strip("サーバに接続しています…", color: .blue)
            case .offline: strip("オフラインです。再接続を待っています…", color: .orange)
            default: EmptyView()
            }
        }
        .animation(.easeInOut(duration: 0.2), value: shown)
        .task(id: status) {
            guard status == .connecting || status == .offline else {
                shown = nil
                return
            }
            if shown == nil {
                try? await Task.sleep(for: Self.grace)
                if Task.isCancelled { return }
            }
            shown = status
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
