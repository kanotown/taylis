import SwiftUI

struct MainView: View {
    @Bindable var controller: AppController
    /// M34 (MOBILE_UI.md §5): four tabs, each with its own stack of screens, at a compact width; the iPad's sidebar and
    /// conversation at a regular one (§13). One state for both, carried across a change of size class.
    @State private var nav = MainNavigation()
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.scenePhase) private var scenePhase
    /// The split's sidebar, shown or hidden (the conversation full width).
    @State private var columns: NavigationSplitViewVisibility = .all
    /// The split's width, and whether the sidebar was put away for the thread pane (a narrow window: an iPad in
    /// portrait), to bring it back when the pane closes.
    @State private var splitWidth: CGFloat = 0
    @State private var sidebarAutoHidden = false
    /// M40: the 自分 tab's screens (settings), apart from the conversation routes.
    @State private var youPath: [YouRoute] = []
    /// The home list's tap (ChannelListView's selection), turned into a screen on the home stack.
    @State private var homeSelection: String?
    /// The home list's width: the room of its header's title and 在室状況 pill (PRESENCE.md §9.1).
    @State private var homeWidth: CGFloat = 0
    /// A permalink into a channel I have not joined (M27): the preview opens around this message.
    @State private var previewMessageId: String?
    @State private var sheet: Sheet?
    /// M37: 「移動・検索」 over the whole screen.
    @State private var jumpShown = false
    /// M37: the home's ⋯ 「すべて既読にする」 asks first.
    @State private var confirmMarkAll = false
    @AppStorage(ChannelListView.groupUnreadKey) private var groupUnread = false
    /// Issue #1 (MOBILE_UI.md §5.1): 「スワイプで戻る・進む」, the conversation each tab left last, and a left swipe under way.
    @AppStorage(SwipeNav.settingKey) private var swipeNavigation = true
    @State private var lastConversations: [MainTab: String] = [:]
    @State private var forwardSwipe: ForwardSwipe?

    enum Sheet: Identifiable, Equatable {
        case newDm, newChannel, search, browse, directory, workspaces, newSection, compose
        /// M78: 「キャンバス」's filter searched in the canvases' bodies (the search's 「キャンバス」 tab).
        case canvasSearch(SearchParams)
        /// M122: 「ドキュメント」's search (the search's 「ドキュメント」 tab).
        case pageSearch(SearchParams)
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
            case .canvasSearch: 9
            case .pageSearch: 10
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

    /// The conversation on screen: the top of the selected tab's stack, or the detail column's (M34 (8): only it reads
    /// and is "open").
    private var frontChannelId: String? { nav.frontChannelId }

    /// L8: the Times feed is on a stack.
    private var timesFeedShown: Bool {
        nav.allStacks.contains { $0.contains(.list(TimesFeedView.selectionId)) }
    }

    /// A conversation left the store (I left it or was removed, it went private while previewed, a bootstrap dropped it).
    private var goneChannel: Bool {
        nav.allStacks.contains { path in path.contains { if case .channel(let id) = $0 { store.channel(id) == nil } else { false } } }
    }

    private func path(_ tab: MainTab) -> Binding<[MainRoute]> {
        Binding(get: { nav.paths[tab] ?? [] }, set: { nav.paths[tab] = $0 })
    }

    private func isDm(_ channelId: String) -> Bool { store.channel(channelId)?.channel.isDm == true }

    /// A screen on this tab's stack (the detail column's in the split).
    private func push(_ route: MainRoute, on tab: MainTab) { nav.push(route, on: tab) }

    /// From a notification, a permalink, a search result, a new DM: a DM on the DM tab, a channel on the home tab, its
    /// stack replaced (M34 (7)); alone in the detail column in the split.
    private func land(_ channelId: String, parentId: String? = nil) {
        nav.land(channelId, isDm: isDm(channelId), parentId: isPreview(channelId) ? nil : parentId)
    }

    /// A revealed message (a list row): its conversation on this tab's stack, into its thread if a reply.
    private func show(_ channelId: String, parentId: String?, on tab: MainTab) {
        nav.show(channelId, parentId: isPreview(channelId) ? nil : parentId, on: tab)
    }

    /// 「スレッド」's conversation link / 「チャンネルを開く」: the conversation on this tab's stack, the thread's parent
    /// revealed in its timeline (the thread itself not opened).
    private func showThreadConversation(_ entry: ThreadEntry, on tab: MainTab) {
        Task { if let channelId = await controller.revealThreadParent(entry) { show(channelId, parentId: nil, on: tab) } }
    }

    /// A public channel I have not joined shows as its preview (`screen`), which opens no thread of its own.
    private func isPreview(_ channelId: String) -> Bool {
        guard let channel = store.channel(channelId) else { return false }
        return !channel.isMember && channel.channel.type == "public" && !controller.isGuest
    }

    /// The layout for the window's width. Not while in the background: the app-switcher snapshots are taken at other
    /// sizes, and each flip would rebuild the open conversation (RootView's look waits for the same reason).
    private func applyLayout() {
        guard scenePhase != .background else { return }
        nav.setLayout(MainLayout.of(sizeClass), isDm: isDm)
    }

    var body: some View {
        Group {
            if nav.layout == .split { splitView } else { tabView }
        }
        .safeAreaInset(edge: .top, spacing: 0) { ConnectionBanner(status: status) }
        .overlay(alignment: .bottom) {
            VStack(spacing: 6) {
                NoticeToast(controller: controller)
                ErrorToast(controller: controller)
            }
            .frame(maxWidth: nav.layout == .split ? 560 : nil)
            .padding(.bottom, nav.layout == .tabs && frontChannelId == nil ? 52 : 0) // above the tab bar where it shows
        }
        .sheet(item: $sheet) { which in
            switch which {
            case .newDm: NewDmView(controller: controller) { id in land(id) }
            case .directory: DirectoryView(controller: controller) { id in land(id) }
            case .newChannel: NewChannelView(controller: controller) { id in land(id) }
            case .search: SearchView(controller: controller)
            case .canvasSearch(let params): SearchView(controller: controller, initial: params, initialTab: .canvases)
            case .pageSearch(let params): SearchView(controller: controller, initial: params, initialTab: .pages)
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
        // M45: a canvas link tapped in a message (CANVAS.md §4.13).
        .sheet(item: $controller.canvasLink) { target in
            CanvasLinkSheet(controller: controller, canvasId: target.id)
        }
        // M122: a wiki page link tapped outside the wiki (a message, a canvas, a notice).
        .sheet(item: $controller.pageLink) { target in
            PageLinkSheet(controller: controller, pageId: target.id)
        }
        // M95: a workflow's form (WORKFLOWS.md §8 4.), from wherever it was opened.
        .fullScreenCover(item: $controller.workflowRun) { target in
            WorkflowFormView(controller: controller, target: target)
        }
        .onChange(of: sizeClass, initial: true) { _, _ in
            applyLayout()
            // A new UI language rebuilt the screens (RootView): back to 自分 → 表示 → 言語, where it was chosen.
            if controller.reopenLanguageSettings {
                controller.reopenLanguageSettings = false
                youPath = [.appearance, .language]
                if nav.layout == .split { nav.youSheet = true } else { nav.tab = .you }
            }
        }
        .onChange(of: scenePhase) { _, _ in applyLayout() }
        .onChange(of: homeSelection) { _, id in
            guard let id else { return }
            homeSelection = nil
            nav.select(id.isListId ? .list(id) : .channel(id))
        }
        .onChange(of: timesFeedShown, initial: true) { _, shown in
            // L8 (TIMES_FEED.md §5 feedVisible): live events add rows while the feed is on a stack (a thread over it too).
            controller.timesFeed.visible = shown
        }
        .onChange(of: frontChannelId, initial: true) { _, id in
            nav.frontChanged()
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
                if sheet == .search || sheet?.isCanvasSearch == true || sheet?.isPageSearch == true { sheet = nil } // a conversation opened from a search result's profile or link
                jumpShown = false // …or from the message search of 移動・検索
                previewMessageId = note.userInfo?["messageId"] as? String
                land(id, parentId: note.userInfo?["parentId"] as? String)
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: KeyCommand.notification)) { note in
            guard let raw = note.userInfo?["command"] as? String, let command = KeyCommand(rawValue: raw) else { return }
            keyCommand(command)
        }
        .onChange(of: nav.paths) { old, new in
            lastConversations = SwipeNav.noteLeft(lastConversations, previous: old, next: new)
        }
        .onChange(of: goneChannel) { _, gone in
            guard gone else { return }
            nav.dropChannels { store.channel($0) == nil }
        }
        .onChange(of: PushCenter.shared.pendingCalendar, initial: true) { _, pending in
            // M52: a tapped alarm of my own calendar: the calendar, on the home tab, shows the event.
            guard pending else { return }
            PushCenter.shared.pendingCalendar = false
            nav.landList(CalendarView.selectionId)
        }
        .onChange(of: PushCenter.shared.pendingTasks, initial: true) { _, pending in
            // M56: a tapped notification of my own task: 「タスク」, on the home tab, shows it.
            guard pending else { return }
            PushCenter.shared.pendingTasks = false
            nav.landList(MyTasksView.selectionId)
        }
        .onChange(of: PushCenter.shared.pendingPage, initial: true) { _, pageId in
            // M122: a tapped page notification: the page over 「ドキュメント」 on the home tab.
            guard let pageId else { return }
            PushCenter.shared.pendingPage = nil
            nav.landPage(pageId, docsId: DocsView.selectionId)
        }
        .onChange(of: PushCenter.shared.pendingReservations, initial: true) { _, pending in
            // M112: a tapped reservation notice: 「予約」, on the home tab.
            guard pending else { return }
            PushCenter.shared.pendingReservations = false
            nav.landList(ReservationsView.selectionId)
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

    /// The hardware keyboard's shortcuts (KeyCommand), only with nothing presented over the screen.
    private func keyCommand(_ command: KeyCommand) {
        guard sheet == nil, !jumpShown, !nav.youSheet else { return }
        switch command {
        case .jump: jumpShown = true
        case .compose: sheet = .compose
        case .search: sheet = .search
        case .back: nav.back()
        case .closeThread: if nav.layout == .split { nav.openThread = nil }
        }
    }

    // MARK: the phone's tabs

    private var tabView: some View {
        TabView(selection: Binding(get: { nav.tab }, set: { selected in
            // Tapping the open tab again: back to its first screen.
            if selected == nav.tab {
                nav.paths[selected] = []
                if selected == .you { youPath = [] }
            }
            nav.tab = selected
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
            YouView(controller: controller, path: $youPath, onOpenAttendance: openAttendance)
                .tabItem { Label("自分", systemImage: "person.crop.circle") }
                .tag(MainTab.you)
        }
        // M39: the activity badge is red only with a mention among its items.
        .background(TabBadgeTint(index: 2, count: activityBadge.count, mention: activityBadge.mention))
        .overlay { forwardSwipeOverlay }
    }

    // MARK: the left swipe on a tab's root (issue #1, MOBILE_UI.md §5.1)

    /// The conversation a left swipe on `tab`'s root brings back, if any (not with a sheet or 移動・検索 over the screen).
    private func forwardTarget(_ tab: MainTab) -> String? {
        guard nav.layout == .tabs, sheet == nil, !jumpShown else { return nil }
        return SwipeNav.forwardTarget(tab: tab, path: nav.paths[tab] ?? [], last: lastConversations) { store.channel($0) != nil }
    }

    /// The recognizer on `tab`'s navigation (ForwardSwipeProbe), as the background of its root screen.
    private func forwardProbe(_ tab: MainTab) -> some View {
        ForwardSwipeProbe(canForward: forwardTarget(tab) != nil, enabled: swipeNavigation, onChange: { shift in
            if forwardSwipe == nil, let id = forwardTarget(tab) { forwardSwipe = ForwardSwipe(tab: tab, channelId: id) }
            forwardSwipe?.shift = shift
        }, onEnd: { complete in finishForwardSwipe(complete) })
    }

    /// Let go: the page slides the rest of the way and the conversation is pushed under it without an animation (then
    /// the page goes), or it slides back out.
    private func finishForwardSwipe(_ complete: Bool) {
        guard let swipe = forwardSwipe else { return }
        guard complete else {
            withAnimation(.easeOut(duration: 0.2)) { forwardSwipe?.shift = 1 } completion: { forwardSwipe = nil }
            return
        }
        withAnimation(.easeOut(duration: 0.2)) { forwardSwipe?.shift = 0 } completion: {
            var transaction = Transaction()
            transaction.disablesAnimations = true
            withTransaction(transaction) { nav.paths[swipe.tab, default: []].append(.channel(swipe.channelId)) }
            // The conversation draws under the page first; the page then fades out over it.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
                withAnimation(.easeOut(duration: 0.15)) { forwardSwipe = nil }
            }
        }
    }

    @ViewBuilder
    private var forwardSwipeOverlay: some View {
        if let swipe = forwardSwipe, let channel = store.channel(swipe.channelId) {
            GeometryReader { geometry in
                ZStack(alignment: .topLeading) {
                    Color.black.opacity(SwipeNav.scrimOpacity(shift: swipe.shift)).ignoresSafeArea()
                    ForwardSwipePage(title: channelTitle(channel, store: store))
                        .background(Color(.systemBackground).ignoresSafeArea())
                        .shadow(color: .black.opacity(0.16), radius: 8, x: -3)
                        .offset(x: swipe.shift * geometry.size.width)
                }
            }
            .allowsHitTesting(false)
            .accessibilityHidden(true)
        }
    }

    private var homeTab: some View {
        NavigationStack(path: path(.home)) {
            homeList(sidebar: false)
                .background(forwardProbe(.home))
                .navigationDestination(for: MainRoute.self) { route in screen(route, on: .home) }
        }
    }

    /// The home's list: the home tab's first screen, or the split's sidebar.
    private func homeList(sidebar: Bool) -> some View {
        ChannelListView(controller: controller, selection: $homeSelection, onJump: { jumpShown = true }, onAllDms: {
            if sidebar {
                nav.select(.list(MainNavigation.dmsId))
            } else {
                nav.paths[.dms] = []
                nav.tab = .dms
            }
        }, current: sidebar ? sidebarCurrent : nil,
           activity: sidebar ? .init(count: activityBadge.count, mention: activityBadge.mention, selected: nav.sidebarSelection == .list(MainNavigation.activityId),
                                     open: { nav.select(.list(MainNavigation.activityId)) }) : nil)
        .overlay(alignment: .bottomTrailing) { composeButton }
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { homeWidth = $0 }
        .navigationTitle(controller.workspaceName)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            // M16c / M37: the workspace on screen; with two or more, a tap opens the switcher.
            // PRESENCE.md §9.1: my 在室状況 pill right beside the name (while the board is on for me).
            ToolbarItem(placement: .principal) {
                HomeHeaderTitle(controller: controller, room: AttendanceRules.headerRoom(barWidth: homeWidth), onSwitch: { sheet = .workspaces },
                                onOpenBoard: openAttendance)
            }
            // M38: my picture (to the 自分 tab) with my presence, and the connection while it is down. Without the
            // glass circle iOS 26 puts behind a bar item: a rounded-square picture in a circle looked odd, and the
            // glass washed the badge's colour out (testers, 2026-09-30).
            if #available(iOS 26.0, *) {
                ToolbarItem(placement: .topBarLeading) {
                    HomeAvatarButton(controller: controller, status: status) { openYou() }
                }
                .sharedBackgroundVisibility(.hidden)
            } else {
                ToolbarItem(placement: .topBarLeading) {
                    HomeAvatarButton(controller: controller, status: status) { openYou() }
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
    }

    /// The sidebar row of the detail column's first screen (a conversation, or one of the lists).
    private var sidebarCurrent: String? {
        switch nav.sidebarSelection {
        case .channel(let id)?: id
        case .list(let id)?: id
        case .thread(let id, _)?: id
        case .page?: DocsView.selectionId
        case nil: nil
        }
    }

    /// My picture at the home's top left: the 自分 tab, or 自分 as a sheet over the split.
    private func openYou() {
        if nav.layout == .split { nav.youSheet = true } else { nav.tab = .you }
    }

    /// The pill's 「在室状況を開く」 (the home header or 自分): the page alone on the home tab, or in the detail column.
    private func openAttendance() {
        if nav.layout == .split {
            nav.youSheet = false
            nav.select(.list(AttendanceView.selectionId))
        } else {
            nav.paths[.home] = [.list(AttendanceView.selectionId)]
            nav.tab = .home
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
        .hoverEffect(.lift)
        .padding(.trailing, 16)
        .padding(.bottom, 16)
        .accessibilityLabel("新しいメッセージ")
    }

    private var dmTab: some View {
        NavigationStack(path: path(.dms)) {
            dmList(on: .dms)
                .background(forwardProbe(.dms))
                .navigationDestination(for: MainRoute.self) { route in screen(route, on: .dms) }
        }
    }

    private func dmList(on tab: MainTab) -> some View {
        DMListView(controller: controller, onOpen: { push(.channel($0), on: tab) }, onNew: { sheet = .newDm })
    }

    private var activityTab: some View {
        NavigationStack(path: path(.activity)) {
            activityList(on: .activity)
                .background(forwardProbe(.activity))
                .navigationDestination(for: MainRoute.self) { route in screen(route, on: .activity) }
        }
    }

    private func activityList(on tab: MainTab) -> some View {
        ActivityView(controller: controller, onOpenMention: { message in
            Task { if await controller.revealMessage(message) { show(message.channelId, parentId: message.parentId, on: tab) } }
        }, onOpenItem: { item in
            // M122: a page that mentions me or was shared with me: the page on this tab's stack.
            if let page = item.page {
                nav.openPage(page.pageId, on: tab)
                return
            }
            // M112: a reservation notice opens 「予約」 on this tab's stack.
            if item.reservation != nil {
                if nav.layout == .split { nav.landList(ReservationsView.selectionId) } else { nav.paths[tab, default: []].append(.list(ReservationsView.selectionId)) }
                return
            }
            // M77: a canvas, in its conversation's 「キャンバス」 tab on this tab's stack (Back: the activity), or its
            // own sheet for a conversation I am not in.
            if let canvas = item.canvas {
                Task { if await controller.openActivityCanvas(item) { show(canvas.channelId, parentId: nil, on: tab) } }
                return
            }
            // M39: the message in its conversation, a reply in its thread, on this tab's stack.
            guard let message = item.message else { return }
            Task { if await controller.revealMessage(message) { show(message.channelId, parentId: message.parentId, on: tab) } }
        }, onOpenThreadConversation: { showThreadConversation($0, on: tab) })
    }

    // MARK: the iPad's split (MOBILE_UI.md §13)

    private var splitView: some View {
        NavigationSplitView(columnVisibility: $columns) {
            homeList(sidebar: true)
                .navigationSplitViewColumnWidth(min: 280, ideal: 320, max: 400)
        } detail: {
            NavigationStack(path: Binding(get: { Array(nav.split.dropFirst()) }, set: { tail in
                nav.split = Array(nav.split.prefix(1)) + tail
            })) {
                Group {
                    if let root = nav.split.first {
                        screen(root, on: .home).id(root)
                    } else {
                        ContentUnavailableView("会話を選んでください", systemImage: "bubble.left.and.bubble.right",
                                               description: Text("左の一覧からチャンネルや DM を開きます。⌘K で移動・検索、⌘N で新しいメッセージ。"))
                    }
                }
                .navigationDestination(for: MainRoute.self) { route in screen(route, on: .home) }
            }
            .environment(\.threadInPane, true)
            // The front conversation's thread, in a pane beside it (Slack's right panel); the conversation stays read.
            .inspector(isPresented: Binding(get: { paneThread != nil }, set: { if !$0 { nav.openThread = nil } })) {
                threadPane
            }
        }
        .navigationSplitViewStyle(.balanced)
        .onGeometryChange(for: CGFloat.self, of: { $0.size.width }) { width in splitWidth = width }
        // Sidebar, conversation and thread need about 1180 pt; narrower (portrait) the sidebar steps aside while the
        // pane is open and comes back with its close — unless it was changed by hand meanwhile.
        .onChange(of: PaneRoom(thread: paneThread != nil, width: splitWidth)) { _, room in
            if room.thread && MainNavigation.sidebarStepsAside(width: room.width) {
                if columns != .detailOnly {
                    columns = .detailOnly
                    sidebarAutoHidden = true
                }
            } else if sidebarAutoHidden {
                sidebarAutoHidden = false
                if columns == .detailOnly { columns = .all }
            }
        }
        .sheet(isPresented: $nav.youSheet) {
            YouView(controller: controller, path: $youPath, onClose: { nav.youSheet = false }, onOpenAttendance: openAttendance)
        }
    }

    private struct PaneRoom: Equatable {
        let thread: Bool
        let width: CGFloat
    }

    /// The thread the split's pane shows: the one open in the conversation in front, while that conversation is there.
    private var paneThread: ThreadRef? {
        guard nav.layout == .split, let open = nav.openThread, open.channelId == nav.frontChannelId,
              store.channel(open.channelId) != nil else { return nil }
        return open
    }

    /// The split's thread pane (MOBILE_UI.md §13). The inspector shares the detail column's bar (the thread's follow
    /// and ⋯ go to its end, over the pane), so the pane says what it is and closes from a header row of its own.
    @ViewBuilder
    private var threadPane: some View {
        if let thread = paneThread {
            VStack(spacing: 0) {
                HStack(spacing: 8) {
                    VStack(alignment: .leading, spacing: 1) {
                        Text("スレッド").font(.headline)
                        if let channel = store.channel(thread.channelId) {
                            Text(channelTitle(channel, store: store)).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                        }
                    }
                    Spacer(minLength: 0)
                    Button { nav.openThread = nil } label: {
                        Image(systemName: "xmark").font(.body.weight(.semibold)).frame(width: 36, height: 36).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.secondary)
                    .hoverEffect(.highlight)
                    .accessibilityLabel("スレッドを閉じる")
                }
                .padding(.leading, 16)
                .padding(.trailing, 8)
                .padding(.vertical, 6)
                Divider()
                ThreadView(controller: controller, channelId: thread.channelId, parentId: thread.parentId)
            }
            .id(thread.parentId)
            .inspectorColumnWidth(min: 340, ideal: 400, max: 520)
        }
    }

    /// A screen of a tab's stack (or the detail column's): a list, or a conversation (or its preview) without the tab bar.
    @ViewBuilder
    private func screen(_ route: MainRoute, on tab: MainTab) -> some View {
        switch route {
        case .list(let id): list(id, on: tab)
        case .page(let pageId):
            // M122: a wiki page; its links, breadcrumbs and child pages go on this stack.
            WikiPageScreen(controller: controller, pageId: pageId, onOpenPage: { nav.openPage($0, on: tab) })
                .id(pageId)
                .modifier(HidesTabBar())
        case .thread(let channelId, let parentId):
            // Pushed with its conversation under it (MainNavigation.show / land): Back goes to the conversation.
            if store.channel(channelId) != nil {
                ThreadView(controller: controller, channelId: channelId, parentId: parentId).modifier(HidesTabBar())
            } else {
                ContentUnavailableView("会話が見つかりません", systemImage: "bubble.left.and.bubble.right")
            }
        case .channel(let id):
            if let channel = store.channel(id) {
                Group {
                    if !channel.isMember && channel.channel.type == "public" && !controller.isGuest {
                        // M27: a public channel I have not joined is read before joining (Slack); joining shows the channel.
                        ChannelPreviewView(controller: controller, channelId: channel.id, focusMessageId: previewMessageId).id("preview " + channel.id)
                    } else {
                        // View state resets; conversation drafts live in the persistent Store.
                        ChannelView(controller: controller, channelId: channel.id, pendingThreadId: Binding(
                            get: { nav.pendingThread?.channelId == id ? nav.pendingThread?.parentId : nil },
                            set: { value in if value == nil, nav.pendingThread?.channelId == id { nav.pendingThread = nil } }),
                            onThreadChange: { parentId in
                                // Only the front conversation's thread is carried across a change of layout.
                                guard nav.frontChannelId == id else { return }
                                nav.openThread = parentId.map { ThreadRef(channelId: id, parentId: $0) }
                            })
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
        case MainNavigation.dmsId: dmList(on: tab)
        case MainNavigation.activityId: activityList(on: tab)
        case ThreadsListView.selectionId:
            ThreadsListView(controller: controller, onOpenConversation: { showThreadConversation($0, on: tab) })
        case TimesFeedView.selectionId:
            // L8: a row shows its message in the channel (a reply shared there too, as the channel's row), on this stack.
            TimesFeedView(controller: controller, onOpen: { message in
                let parentId = message.alsoInChannel ? nil : message.parentId
                Task {
                    if await controller.revealMessage(id: message.id, channelId: message.channelId, parentId: parentId) {
                        show(message.channelId, parentId: parentId, on: tab)
                    }
                }
            }, onOpenChannel: { id in show(id, parentId: nil, on: tab) })
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
        case CalendarView.selectionId:
            CalendarView(controller: controller)  // M52
        case MyTasksView.selectionId:
            MyTasksView(controller: controller) { channelId in  // M56: 「自分の担当」's channel name opens its 「タスク」 tab
                controller.taskOpen = TaskOpen(taskId: nil, channelId: channelId)
                show(channelId, parentId: nil, on: tab)
            }
        case DeadlinesView.selectionId:
            DeadlinesView(controller: controller)  // M86: a row opens the deadline over the list, on this stack
        case ReservationsView.selectionId:
            ReservationsView(controller: controller)  // M112
        case AttendanceView.selectionId:
            AttendanceView(controller: controller)  // M140
        case FilesView.selectionId:
            FilesView(controller: controller) { messageId, channelId, parentId in
                Task {
                    if await controller.revealMessage(id: messageId, channelId: channelId, parentId: parentId) { show(channelId, parentId: parentId, on: tab) }
                }
            }
        case DraftsView.selectionId:
            DraftsView(controller: controller) { channelId, parentId in show(channelId, parentId: parentId, on: tab) }
        case DocsView.selectionId:
            // M122: the wiki's tree; a page goes on this stack.
            DocsView(controller: controller, onOpen: { nav.openPage($0, on: tab) }, onSearch: { params in sheet = .pageSearch(params) })
        case CanvasesView.selectionId:
            // M78: a canvas in its conversation's 「キャンバス」 tab on this stack (Back: the list), or its own sheet for a
            // conversation not on this device.
            CanvasesView(controller: controller, onOpen: { canvas in
                Task { if await controller.openListedCanvas(canvas) { show(canvas.channelId, parentId: nil, on: tab) } }
            }, onSearch: { params in sheet = .canvasSearch(params) })
        default:
            EmptyView()
        }
    }
}

private extension MainView.Sheet {
    var isCanvasSearch: Bool { if case .canvasSearch = self { true } else { false } }
    var isPageSearch: Bool { if case .pageSearch = self { true } else { false } }
}

private extension String {
    /// A selection naming one of the lists rather than a conversation.
    var isListId: Bool {
        [DraftsView.selectionId, FilesView.selectionId, MentionsView.selectionId, RemindersView.selectionId,
         SavedView.selectionId, ThreadsListView.selectionId, CalendarView.selectionId, MyTasksView.selectionId,
         TimesFeedView.selectionId, CanvasesView.selectionId, DeadlinesView.selectionId, ReservationsView.selectionId,
         DocsView.selectionId, AttendanceView.selectionId].contains(self)
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
        case .online: tr("オンライン")
        case .away: tr("離席中")
        case .dnd: tr("通知を一時停止中")
        case .connecting: tr("接続中")
        case .offline: tr("オフライン、再接続中")
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
        .accessibilityLabel([tr("自分"), badge.spoken].compactMap { $0 }.joined(separator: tr("、")))
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
            case .connecting: strip(tr("サーバに接続しています…"), color: .accentColor)
            case .offline: strip(tr("オフラインです。再接続を待っています…"), color: .orange)
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

