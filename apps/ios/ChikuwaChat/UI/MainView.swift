import SwiftUI

struct MainView: View {
    @Bindable var controller: AppController
    /// M34 (MOBILE_UI.md §5): four tabs, each with its own stack of screens (the app is iPhone only: always tabs).
    @State private var tab: MainTab = .home
    @State private var paths: [MainTab: [MainRoute]] = [:]
    /// The home list's tap (ChannelListView's selection), turned into a screen on the home stack.
    @State private var homeSelection: String?
    /// A permalink into a channel I have not joined (M27): the preview opens around this message.
    @State private var previewMessageId: String?
    @State private var sheet: Sheet?
    /// A thread to open over a conversation once it shows (a reply's notification, a revealed reply…); only that
    /// conversation takes it, not another one lower on a stack.
    @State private var pendingThread: PendingThread?

    struct PendingThread: Equatable {
        let channelId: String
        let parentId: String
    }

    enum Sheet: Identifiable {
        case newDm, newChannel, search, browse, directory, workspaces, newSection
        var id: Int { switch self { case .newDm: 0; case .newChannel: 1; case .search: 2; case .browse: 4; case .directory: 5; case .workspaces: 6; case .newSection: 7 } }
    }

    private var status: EngineStatus { controller.engine?.status ?? .idle }
    private var store: Store { controller.store }
    /// A tapped notification's conversation once the store knows it; a new DM or channel only arrives with the
    /// bootstrap after the tap, so this is watched rather than checked once.
    private var pendingChannelReady: String? {
        guard let id = PushCenter.shared.pendingChannelId, store.channel(id) != nil else { return nil }
        return id
    }

    /// The conversation on screen: the top of the selected tab's stack (M34 (8): only it reads and is "open").
    private var frontChannelId: String? {
        if case .channel(let id)? = paths[tab]?.last { return id }
        return nil
    }

    /// A conversation left the store (I left it or was removed, it went private while previewed, a bootstrap dropped it).
    private var goneChannel: Bool {
        paths.values.contains { path in path.contains { if case .channel(let id) = $0 { store.channel(id) == nil } else { false } } }
    }

    private func path(_ tab: MainTab) -> Binding<[MainRoute]> {
        Binding(get: { paths[tab] ?? [] }, set: { paths[tab] = $0 })
    }

    /// A screen on this tab's stack.
    private func push(_ route: MainRoute, on tab: MainTab) {
        paths[tab, default: []].append(route)
    }

    /// From a notification, a permalink, a search result, a new DM: a DM on the DM tab, a channel on the home tab, its
    /// stack replaced (M34 (7)).
    private func land(_ channelId: String, parentId: String? = nil) {
        let target: MainTab = store.channel(channelId)?.channel.isDm == true ? .dms : .home
        paths[target] = [.channel(channelId)]
        tab = target
        if let parentId { pendingThread = PendingThread(channelId: channelId, parentId: parentId) }
    }

    /// A revealed message (a list row): its conversation on this tab's stack, into its thread if a reply.
    private func show(_ channelId: String, parentId: String?, on tab: MainTab) {
        push(.channel(channelId), on: tab)
        if let parentId { pendingThread = PendingThread(channelId: channelId, parentId: parentId) }
    }

    var body: some View {
        TabView(selection: Binding(get: { tab }, set: { selected in
            // Tapping the open tab again: back to its first screen.
            if selected == tab { paths[selected] = [] }
            tab = selected
        })) {
            homeTab
                .tabItem { Label("ホーム", systemImage: "house") }
                .badge(TabBadges.homeDot(Array(store.channels.values), meId: store.me?.id) ? " " : nil) // a dot, no number
                .tag(MainTab.home)
            dmTab
                .tabItem { Label("DM", systemImage: "bubble.left.and.bubble.right") }
                .badge(TabBadges.dms(Array(store.channels.values), meId: store.me?.id))
                .tag(MainTab.dms)
            activityTab
                .tabItem { Label("アクティビティ", systemImage: "bell") }
                .badge(TabBadges.activity(Array(store.channels.values), threads: store.threadSummary).count)
                .tag(MainTab.activity)
            SettingsView(controller: controller, embedded: true)
                .tabItem { Label("自分", systemImage: "person.crop.circle") }
                .tag(MainTab.you)
        }
        .safeAreaInset(edge: .top, spacing: 0) { ConnectionBanner(status: status) }
        .overlay(alignment: .bottom) {
            VStack(spacing: 6) {
                NoticeToast(controller: controller)
                ErrorToast(controller: controller)
            }
            .padding(.bottom, frontChannelId == nil ? 52 : 0) // above the tab bar where it shows
        }
        .sheet(item: $sheet) { which in
            switch which {
            case .newDm: NewDmView(controller: controller) { id in land(id) }
            case .directory: DirectoryView(controller: controller) { id in land(id) }
            case .newChannel: NewChannelView(controller: controller) { id in land(id) }
            case .search: SearchView(controller: controller)
            case .browse: ChannelBrowserView(controller: controller) { id in land(id) }
            case .workspaces: WorkspaceSwitcherSheet(controller: controller)
            case .newSection: SectionFormView(controller: controller, section: nil)
            }
        }
        .onChange(of: homeSelection) { _, id in
            guard let id else { return }
            homeSelection = nil
            push(id.isListId ? .list(id) : .channel(id), on: .home)
        }
        .onChange(of: frontChannelId, initial: true) { _, id in
            if controller.messageFocus?.channelId != id { controller.messageFocus = nil }
            if let id, let engine = controller.engine {
                Task { await engine.openChannel(id) }
            } else {
                controller.engine?.closeConversation() // a list, or another tab's first screen: no conversation is open
                if previewMessageId != nil { previewMessageId = nil }
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .chikuwaOpenChannel)) { note in
            if let id = note.userInfo?["id"] as? String {
                if sheet == .search { sheet = nil } // a conversation opened from a search result's profile or link
                previewMessageId = note.userInfo?["messageId"] as? String
                land(id, parentId: note.userInfo?["parentId"] as? String)
            }
        }
        .onChange(of: goneChannel) { _, gone in
            guard gone else { return }
            for (key, path) in paths {
                if let index = path.firstIndex(where: { if case .channel(let id) = $0 { store.channel(id) == nil } else { false } }) {
                    paths[key] = Array(path[..<index])
                }
            }
        }
        .onChange(of: pendingChannelReady, initial: true) { _, id in
            // A tapped notification opens its channel once the store knows it (after bootstrap / catch_up).
            if let id {
                land(id, parentId: PushCenter.shared.pendingParentId) // a reply's thread (M28d)
                PushCenter.shared.pendingChannelId = nil
                PushCenter.shared.pendingParentId = nil
            }
        }
    }

    private var homeTab: some View {
        NavigationStack(path: path(.home)) {
            ChannelListView(controller: controller, selection: $homeSelection)
                .navigationTitle(controller.workspaceName)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    // M16c: the workspace on screen; with two or more, a tap opens the switcher.
                    ToolbarItem(placement: .principal) { WorkspaceTitle(controller: controller) { sheet = .workspaces } }
                    ToolbarItem(placement: .topBarLeading) {
                        Button { tab = .you } label: {
                            if let me = store.me {
                                AvatarView(id: me.id, name: me.displayName, size: 30)
                            } else {
                                Image(systemName: "person.crop.circle")
                            }
                        }
                        .accessibilityLabel("自分")
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
                .navigationDestination(for: MainRoute.self) { route in screen(route, on: .home) }
        }
    }

    private var dmTab: some View {
        NavigationStack(path: path(.dms)) {
            DMListView(controller: controller, onOpen: { push(.channel($0), on: .dms) }, onNew: { sheet = .newDm })
                .navigationDestination(for: MainRoute.self) { route in screen(route, on: .dms) }
        }
    }

    private var activityTab: some View {
        NavigationStack(path: path(.activity)) {
            ActivityView(controller: controller) { message in
                Task { if await controller.revealMessage(message) { show(message.channelId, parentId: message.parentId, on: .activity) } }
            }
            .navigationDestination(for: MainRoute.self) { route in screen(route, on: .activity) }
        }
    }

    /// A screen of a tab's stack: a list, or a conversation (or its preview) without the tab bar.
    @ViewBuilder
    private func screen(_ route: MainRoute, on tab: MainTab) -> some View {
        switch route {
        case .list(let id): list(id, on: tab)
        case .channel(let id):
            if let channel = store.channel(id) {
                Group {
                    if !channel.isMember && channel.channel.type == "public" && !controller.isGuest {
                        // M27: a public channel I have not joined is read before joining (Slack); joining shows the channel.
                        ChannelPreviewView(controller: controller, channelId: channel.id, focusMessageId: previewMessageId).id("preview " + channel.id)
                    } else {
                        // View state resets; conversation drafts live in the persistent Store.
                        ChannelView(controller: controller, channelId: channel.id, pendingThreadId: Binding(
                            get: { pendingThread?.channelId == id ? pendingThread?.parentId : nil },
                            set: { value in if value == nil, pendingThread?.channelId == id { pendingThread = nil } }))
                            .id(channel.id)
                    }
                }
                .modifier(HidesTabBar())
            } else {
                ContentUnavailableView("会話が見つかりません", systemImage: "bubble.left.and.bubble.right")
            }
        }
    }

    /// The lists the home screen's chips open (threads, saved, reminders, files, drafts; mentions from anywhere).
    @ViewBuilder
    private func list(_ id: String, on tab: MainTab) -> some View {
        switch id {
        case ThreadsListView.selectionId: ThreadsListView(controller: controller)
        case SavedView.selectionId:
            SavedView(controller: controller) { message in
                Task { if await controller.revealMessage(message) { show(message.channelId, parentId: message.parentId, on: tab) } }
            }
        case MentionsView.selectionId:
            MentionsView(controller: controller) { message in
                Task { if await controller.revealMessage(message) { show(message.channelId, parentId: message.parentId, on: tab) } }
            }
        case RemindersView.selectionId:
            RemindersView(controller: controller) { row in Task { await controller.openPermalink(row.messageId) } }
        case FilesView.selectionId:
            FilesView(controller: controller) { messageId, channelId, parentId in
                Task {
                    if await controller.revealMessage(id: messageId, channelId: channelId, parentId: parentId) { show(channelId, parentId: parentId, on: tab) }
                }
            }
        case DraftsView.selectionId:
            DraftsView(controller: controller) { channelId, parentId in show(channelId, parentId: parentId, on: tab) }
        default:
            EmptyView()
        }
    }
}

private extension String {
    /// A selection naming one of the lists rather than a conversation.
    var isListId: Bool {
        [DraftsView.selectionId, FilesView.selectionId, MentionsView.selectionId, RemindersView.selectionId,
         SavedView.selectionId, ThreadsListView.selectionId].contains(self)
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
    // A DM with only me (notes to self) goes by my own name, as in Slack and Mattermost.
    if others.isEmpty { return store.me.map { $0.displayName.isEmpty ? $0.username : $0.displayName } ?? "…" }
    return others.map { store.users[$0]?.displayName ?? "…" }.joined(separator: ", ")
}

/// Muted when the level is "none" or a timed mute is active.
@MainActor
func isMuted(_ channel: ChannelState) -> Bool { channel.isMuted }
