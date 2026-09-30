import SwiftUI

struct MainView: View {
    @Bindable var controller: AppController
    /// M34 (MOBILE_UI.md §5): four tabs, each with its own stack of screens (the app is iPhone only: always tabs).
    @State private var tab: MainTab = .home
    @State private var paths: [MainTab: [MainRoute]] = [:]
    /// M40: the 自分 tab's screens (settings), apart from the conversation routes.
    @State private var youPath: [YouRoute] = []
    /// The home list's tap (ChannelListView's selection), turned into a screen on the home stack.
    @State private var homeSelection: String?
    /// A permalink into a channel I have not joined (M27): the preview opens around this message.
    @State private var previewMessageId: String?
    @State private var sheet: Sheet?
    /// A thread to open over a conversation once it shows (a reply's notification, a revealed reply…); only that
    /// conversation takes it, not another one lower on a stack.
    @State private var pendingThread: PendingThread?
    /// M37: 「移動・検索」 over the whole screen.
    @State private var jumpShown = false
    /// M37: the home's ⋯ 「すべて既読にする」 asks first.
    @State private var confirmMarkAll = false
    @AppStorage(ChannelListView.groupUnreadKey) private var groupUnread = false

    struct PendingThread: Equatable {
        let channelId: String
        let parentId: String
    }

    enum Sheet: Identifiable {
        case newDm, newChannel, search, browse, directory, workspaces, newSection, compose
        var id: Int {
            switch self {
            case .newDm: 0
            case .newChannel: 1
            case .search: 2
            case .browse: 4
            case .directory: 5
            case .workspaces: 6
            case .newSection: 7
            case .compose: 8
            }
        }
    }

    private var status: EngineStatus { controller.engine?.status ?? .idle }
    private var store: Store { controller.store }
    /// A tapped notification's conversation once the store knows it; a new DM or channel only arrives with the
    /// bootstrap after the tap, so this is watched rather than checked once.
    private var pendingChannelReady: String? {
        guard let id = PushCenter.shared.pendingChannelId, store.channel(id) != nil else { return nil }
        return id
    }

    /// The activity tab's badge: stage B's unread items (M39), else stage A's rule.
    private var activityBadge: (count: Int, mention: Bool) {
        TabBadges.activity(Array(store.channels.values), threads: store.threadSummary, activity: store.activity)
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
            if selected == tab {
                paths[selected] = []
                if selected == .you { youPath = [] }
            }
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
                .badge(activityBadge.count)
                .tag(MainTab.activity)
            YouView(controller: controller, path: $youPath)
                .tabItem { Label("自分", systemImage: "person.crop.circle") }
                .tag(MainTab.you)
        }
        // M39: the activity badge is red only with a mention among its items.
        .background(TabBadgeTint(index: 2, count: activityBadge.count, mention: activityBadge.mention))
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
            case .compose:
                NewMessageView(controller: controller) { id, focus in
                    if focus { controller.composerFocus = id }
                    land(id)
                }
            }
        }
        .fullScreenCover(isPresented: $jumpShown) {
            JumpView(controller: controller) { id in
                jumpShown = false
                land(id)
            }
        }
        .onChange(of: homeSelection) { _, id in
            guard let id else { return }
            homeSelection = nil
            push(id.isListId ? .list(id) : .channel(id), on: .home)
        }
        .onChange(of: frontChannelId, initial: true) { _, id in
            if controller.messageFocus?.channelId != id { controller.messageFocus = nil }
            // M37: 「最近の会話」 of 移動・検索, whichever tab it opened on.
            if let id { RecentConversations.push(id, key: controller.recentConversationKey) }
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
                jumpShown = false // …or from the message search of 移動・検索
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
            ChannelListView(controller: controller, selection: $homeSelection, onJump: { jumpShown = true }, onAllDms: {
                paths[.dms] = []
                tab = .dms
            })
            .overlay(alignment: .bottomTrailing) { composeButton }
            .navigationTitle(controller.workspaceName)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                // M16c / M37: the workspace on screen; with two or more, a tap opens the switcher.
                ToolbarItem(placement: .principal) { WorkspaceTitle(controller: controller) { sheet = .workspaces } }
                // M38: my picture (to the 自分 tab) with my presence, and the connection while it is down. Without the
                // glass circle iOS 26 puts behind a bar item: a rounded-square picture in a circle looked odd, and the
                // glass washed the badge's colour out (testers, 2026-09-30).
                if #available(iOS 26.0, *) {
                    ToolbarItem(placement: .topBarLeading) {
                        HomeAvatarButton(controller: controller, status: status) { tab = .you }
                    }
                    .sharedBackgroundVisibility(.hidden)
                } else {
                    ToolbarItem(placement: .topBarLeading) {
                        HomeAvatarButton(controller: controller, status: status) { tab = .you }
                    }
                }
                ToolbarItem(placement: .topBarTrailing) { homeMenu }
            }
            .alert("すべて既読にしますか？", isPresented: $confirmMarkAll) {
                Button("既読にする") { Task { await controller.markAllRead() } }
                Button("キャンセル", role: .cancel) {}
            } message: {
                Text("すべてのチャンネルと DM の未読がなくなります。")
            }
            .navigationDestination(for: MainRoute.self) { route in screen(route, on: .home) }
        }
    }

    /// M37 (1): the home's ⋯ (MOBILE_UI.md §6.1), with what the old ＋ menu had.
    private var homeMenu: some View {
        Menu {
            Button("すべて既読にする", systemImage: "checkmark.circle") { confirmMarkAll = true }
            Toggle(isOn: $groupUnread) { Label("未読をまとめる", systemImage: "tray.full") }
            Divider()
            if !controller.isGuest {
                Button("チャンネルを探す", systemImage: "safari") { sheet = .browse }
                Button("チャンネルを作成", systemImage: "number") { sheet = .newChannel }
            }
            Button("メンバー一覧", systemImage: "person.3") { sheet = .directory }
            Divider()
            Button("ダイレクトメッセージ", systemImage: "person.2") { sheet = .newDm }
            Button("新しいセクション", systemImage: "folder.badge.plus") { sheet = .newSection }
        } label: {
            Image(systemName: "ellipsis")
        }
        .accessibilityLabel("その他")
    }

    /// M37 (6): ✏️ 新しいメッセージ, bottom right over the list (the tab bar is below it).
    private var composeButton: some View {
        Button { sheet = .compose } label: {
            Image(systemName: "square.and.pencil")
                .font(.system(size: 22, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 56, height: 56)
                .background(Color.accentColor, in: Circle())
                .shadow(color: .black.opacity(0.22), radius: 6, y: 3)
        }
        .buttonStyle(.plain)
        .padding(.trailing, 16)
        .padding(.bottom, 16)
        .accessibilityLabel("新しいメッセージ")
    }

    private var dmTab: some View {
        NavigationStack(path: path(.dms)) {
            DMListView(controller: controller, onOpen: { push(.channel($0), on: .dms) }, onNew: { sheet = .newDm })
                .navigationDestination(for: MainRoute.self) { route in screen(route, on: .dms) }
        }
    }

    private var activityTab: some View {
        NavigationStack(path: path(.activity)) {
            ActivityView(controller: controller, onOpenMention: { message in
                Task { if await controller.revealMessage(message) { show(message.channelId, parentId: message.parentId, on: .activity) } }
            }, onOpenItem: { item in
                // M39: the message in its conversation, a reply in its thread, on this tab's stack.
                let message = item.message
                Task { if await controller.revealMessage(message) { show(message.channelId, parentId: message.parentId, on: .activity) } }
            })
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

/// What the badge on my picture at the home's top left says (M38): my presence as others see it while connected (DND
/// over it, as the 🔕 beside names), else the connection, which the green dot it replaced stood for alone.
enum HomeAvatarBadge: Equatable {
    case online, away, dnd, connecting, offline, none

    static func of(status: EngineStatus, presence: String, dnd: Bool) -> HomeAvatarBadge {
        switch status {
        case .offline: return .offline
        case .connecting: return .connecting
        case .online:
            if dnd { return .dnd }
            return presence == "online" ? .online : presence == "away" ? .away : .none
        case .idle, .signedOut: return .none
        }
    }

    /// What VoiceOver says after 「自分」.
    var spoken: String? {
        switch self {
        case .online: "オンライン"
        case .away: "離席中"
        case .dnd: "通知を一時停止中"
        case .connecting: "接続中"
        case .offline: "オフライン、再接続中"
        case .none: nil
        }
    }

    /// The picture fades while the connection is down.
    var disconnected: Bool { self == .offline || self == .connecting }
}

/// M38: the home's top left: my picture, a tap to the 自分 tab, and a badge at its bottom right (HomeAvatarBadge).
/// While the connection is down the picture fades and the badge is an orange ring; the strip at the top
/// (ConnectionBanner) says it in words after 2 s.
struct HomeAvatarButton: View {
    @Bindable var controller: AppController
    let status: EngineStatus
    let action: () -> Void
    static let size: CGFloat = 30

    var body: some View {
        let store = controller.store
        let meId = store.me?.id ?? ""
        let badge = HomeAvatarBadge.of(status: status, presence: store.presenceOf(meId), dnd: DND.isActive(store.me?.asPublic))
        Button(action: action) {
            AvatarView(id: meId, name: store.me?.displayName ?? "?", size: Self.size)
                .opacity(badge.disconnected ? 0.5 : 1)
                .overlay(alignment: .bottomTrailing) { dot(badge).offset(x: 3, y: 3) }
                .padding(3)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(["自分", badge.spoken].compactMap { $0 }.joined(separator: "、"))
    }

    @ViewBuilder
    private func dot(_ badge: HomeAvatarBadge) -> some View {
        let side: CGFloat = 11
        switch badge {
        case .online, .away:
            Circle().fill(badge == .online ? Color.green : Color.orange)
                .frame(width: side, height: side)
                .overlay(Circle().stroke(Color(.systemBackground), lineWidth: 2))
        case .dnd:
            Image(systemName: "bell.slash.fill")
                .font(.system(size: 7, weight: .bold)).foregroundStyle(.white)
                .frame(width: side + 2, height: side + 2)
                .background(Color.gray, in: Circle())
                .overlay(Circle().stroke(Color(.systemBackground), lineWidth: 2))
        case .offline:
            Circle().strokeBorder(Color.orange, lineWidth: 2.5)
                .background(Circle().fill(Color(.systemBackground)))
                .frame(width: side, height: side)
        case .connecting:
            Circle().fill(Color.gray)
                .frame(width: side, height: side)
                .overlay(Circle().stroke(Color(.systemBackground), lineWidth: 2))
        case .none:
            EmptyView()
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
            case .connecting: strip("サーバに接続しています…", color: .accentColor)
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
