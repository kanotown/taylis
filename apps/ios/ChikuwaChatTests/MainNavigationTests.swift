import SwiftUI
import XCTest
@testable import ChikuwaChat

/// MOBILE_UI.md §13: the phone's tabs at a compact width, the iPad's split at a regular one, and the navigation state
/// carried across a change of size class (the open conversation, the screens over it, its thread).
final class MainNavigationTests: XCTestCase {
    private let dms: Set<String> = ["dm-1", "dm-2"]
    private func isDm(_ id: String) -> Bool { dms.contains(id) }

    private func navigation(_ layout: MainLayout) -> MainNavigation {
        var nav = MainNavigation()
        nav.setLayout(layout, isDm: isDm)
        return nav
    }

    func testLayoutFollowsTheHorizontalSizeClass() {
        XCTAssertEqual(MainLayout.of(.regular), .split)
        XCTAssertEqual(MainLayout.of(.compact), .tabs)
        XCTAssertEqual(MainLayout.of(nil), .tabs) // unknown: the phone's layout
    }

    func testSidebarStepsAsideForThePaneWhenNarrow() {
        XCTAssertFalse(MainNavigation.sidebarStepsAside(width: 1376)) // 13" landscape
        XCTAssertFalse(MainNavigation.sidebarStepsAside(width: 1210)) // 11" landscape
        XCTAssertTrue(MainNavigation.sidebarStepsAside(width: 1032)) // 13" portrait
        XCTAssertTrue(MainNavigation.sidebarStepsAside(width: 834)) // 11" portrait
        XCTAssertFalse(MainNavigation.sidebarStepsAside(width: 0)) // not measured yet
    }

    // MARK: the sidebar put away for the thread pane (SidebarVisibility)

    private let portrait: CGFloat = 1032
    private let landscape: CGFloat = 1376

    /// Applies what the rule returns, and reports it back as the split's onChange would.
    private func room(_ rule: inout SidebarVisibility, _ columns: inout NavigationSplitViewVisibility, thread: Bool, width: CGFloat) {
        if let next = rule.room(thread: thread, width: width, columns: columns) {
            columns = next
            rule.changed(to: next, paneOpen: thread)
        }
    }

    func testSidebarStepsAsideForThePaneAndComesBack() {
        var rule = SidebarVisibility()
        var columns = NavigationSplitViewVisibility.all
        room(&rule, &columns, thread: true, width: portrait)
        XCTAssertEqual(columns, .detailOnly)
        XCTAssertTrue(rule.autoHidden)
        room(&rule, &columns, thread: false, width: portrait)
        XCTAssertEqual(columns, .all)
        XCTAssertFalse(rule.autoHidden)
    }

    func testSidebarStaysInLandscapeAndReturnsOnRotation() {
        var rule = SidebarVisibility()
        var columns = NavigationSplitViewVisibility.all
        room(&rule, &columns, thread: true, width: landscape)
        XCTAssertEqual(columns, .all)
        room(&rule, &columns, thread: true, width: portrait) // rotated to portrait
        XCTAssertEqual(columns, .detailOnly)
        room(&rule, &columns, thread: true, width: landscape) // and back
        XCTAssertEqual(columns, .all)
    }

    func testSidebarShownByHandWithThePaneOpenIsNotPutAwayAgain() {
        var rule = SidebarVisibility()
        var columns = NavigationSplitViewVisibility.all
        room(&rule, &columns, thread: true, width: portrait)
        columns = .all // 「サイドバーを表示」, ⌃⌘S
        rule.changed(to: columns, paneOpen: true)
        XCTAssertTrue(rule.manual)
        room(&rule, &columns, thread: true, width: landscape) // rotations
        room(&rule, &columns, thread: true, width: portrait)
        XCTAssertEqual(columns, .all)
        room(&rule, &columns, thread: false, width: portrait)
        XCTAssertEqual(columns, .all)
        // The next pane puts it away again: the choice was for that pane.
        room(&rule, &columns, thread: true, width: portrait)
        XCTAssertEqual(columns, .detailOnly)
    }

    func testSidebarHiddenByHandStaysHidden() {
        // Before the pane: it was not put away by the rule, so closing the pane does not bring it back.
        var rule = SidebarVisibility()
        var columns = NavigationSplitViewVisibility.detailOnly
        rule.changed(to: columns, paneOpen: false)
        room(&rule, &columns, thread: true, width: portrait)
        XCTAssertFalse(rule.autoHidden)
        room(&rule, &columns, thread: false, width: portrait)
        XCTAssertEqual(columns, .detailOnly)

        // Shown and hidden again by hand while the pane is open: the close keeps it hidden.
        rule = SidebarVisibility()
        columns = .all
        room(&rule, &columns, thread: true, width: portrait)
        columns = .all
        rule.changed(to: columns, paneOpen: true)
        columns = .detailOnly
        rule.changed(to: columns, paneOpen: true)
        room(&rule, &columns, thread: false, width: portrait)
        XCTAssertEqual(columns, .detailOnly)
    }

    func testSidebarRuleIgnoresItsOwnWrite() {
        var rule = SidebarVisibility()
        XCTAssertEqual(rule.room(thread: true, width: portrait, columns: .all), .detailOnly)
        rule.changed(to: .detailOnly, paneOpen: true) // its own write comes back through onChange
        XCTAssertTrue(rule.autoHidden)
        XCTAssertFalse(rule.manual)
        XCTAssertNil(rule.room(thread: true, width: portrait - 100, columns: .detailOnly)) // a narrower window
    }

    func testLandingInEachLayout() {
        var tabs = navigation(.tabs)
        tabs.land("dm-1", isDm: true)
        XCTAssertEqual(tabs.tab, .dms)
        XCTAssertEqual(tabs.paths[.dms], [.channel("dm-1")])
        // A reply's notification: the conversation and its thread at once, the thread in front (2026-10-06).
        tabs.land("general", isDm: false, parentId: "p1")
        XCTAssertEqual(tabs.tab, .home)
        XCTAssertEqual(tabs.paths[.home], [.channel("general"), .thread(channelId: "general", parentId: "p1")])
        XCTAssertEqual(tabs.frontChannelId, "general")
        XCTAssertNil(tabs.pendingThread)

        var split = navigation(.split)
        split.youSheet = true
        split.land("dm-1", isDm: true)
        XCTAssertEqual(split.split, [.channel("dm-1")])
        XCTAssertFalse(split.youSheet) // a notification's conversation is not left under the settings
        XCTAssertEqual(split.frontChannelId, "dm-1")
        XCTAssertEqual(split.sidebarSelection, .channel("dm-1"))
        XCTAssertTrue(split.paths.isEmpty) // the tabs' stacks are not touched
        split.land("general", isDm: false, parentId: "p1")
        XCTAssertEqual(split.split, [.channel("general")])
        XCTAssertEqual(split.pendingThread, ThreadRef(channelId: "general", parentId: "p1")) // in the pane
    }

    /// 「スレッド」's conversation link (and 「チャンネルを開く」): the thread's parent revealed in its conversation's
    /// timeline, the conversation pushed alone over the list (no thread screen), the thread not loaded.
    @MainActor
    func testAThreadsConversationLinkRevealsTheParentInTheConversation() async throws {
        let parent = MessageOut(id: "p1", channelId: "general", senderId: "u2", seq: 7, updatedSeq: 7, clientMsgId: nil, body: "topic",
                                createdAt: "2026-10-07T01:00:00Z", editedAt: nil, deleted: false, replyCount: 3)
        let entry = ThreadEntry(parent: parent, state: ThreadState(parentId: "p1", channelId: "general", following: true, lastReadSeq: 0,
                                                                   unreadCount: 1, mentionCount: 0, replyCount: 3, lastReplyAt: nil, participantIds: []))
        let context = try JSON.snakeEncoder.encode([parent])
        let recorder = PathRecorder()
        StubProtocol.handler = { request in
            let path = request.url?.path ?? ""
            recorder.add(path)
            return path == "/api/v1/messages/p1/context" ? (200, context) : (404, Data())
        }
        defer { StubProtocol.handler = nil }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubProtocol.self]
        let controller = AppController(defaults: UserDefaults(suiteName: "threads-link-\(UUID())")!)
        controller.api = ApiClient(baseUrl: URL(string: "http://server")!, session: URLSession(configuration: configuration))

        let channelId = await controller.revealThreadParent(entry)
        XCTAssertEqual(channelId, "general")
        XCTAssertEqual(recorder.all, ["/api/v1/messages/p1/context"]) // no replies: the thread is not opened
        let focus = try XCTUnwrap(controller.messageFocus)
        XCTAssertEqual(focus.channelId, "general")
        XCTAssertEqual(focus.messageId, "p1")
        XCTAssertNil(focus.parentId) // highlighted in the channel's timeline, not in a thread

        // MainView then shows it on the tab's stack: the conversation alone, Back to the list.
        var nav = navigation(.tabs)
        nav.tab = .activity
        nav.show(try XCTUnwrap(channelId), parentId: nil, on: .activity)
        XCTAssertEqual(nav.paths[.activity], [.channel("general")])
        XCTAssertEqual(nav.frontChannelId, "general")
        var split = navigation(.split)
        split.select(.list(ThreadsListView.selectionId))
        split.show("general", parentId: nil, on: .home)
        XCTAssertEqual(split.split, [.list(ThreadsListView.selectionId), .channel("general")])
        XCTAssertNil(split.pendingThread)

        // A message that cannot be loaded leaves the screens as they were.
        StubProtocol.handler = { _ in (404, Data(#"{"error": {"code": "not_found", "message": "gone"}}"#.utf8)) }
        controller.messageFocus = nil
        let missing = await controller.revealThreadParent(entry)
        XCTAssertNil(missing)
        XCTAssertNil(controller.messageFocus)
    }

    /// The paths the stubbed server was asked for (its handler runs off the main actor).
    private final class PathRecorder: @unchecked Sendable {
        private let lock = NSLock()
        private var paths: [String] = []
        func add(_ path: String) { lock.lock(); paths.append(path); lock.unlock() }
        var all: [String] { lock.lock(); defer { lock.unlock() }; return paths }
    }

    /// A mentions, saved or Times row of a reply: one push of the conversation and its thread; Back goes to
    /// the conversation, then to the list.
    func testARevealedReplyPushesItsConversationAndThreadAtOnce() {
        var nav = navigation(.tabs)
        nav.tab = .activity
        nav.show("general", parentId: "p1", on: .activity)
        XCTAssertEqual(nav.paths[.activity], [.channel("general"), .thread(channelId: "general", parentId: "p1")])
        XCTAssertEqual(nav.frontChannelId, "general")
        XCTAssertNil(nav.pendingThread)
        nav.back()
        XCTAssertEqual(nav.paths[.activity], [.channel("general")])
        nav.show("random", parentId: nil, on: .activity)
        XCTAssertEqual(nav.paths[.activity], [.channel("general"), .channel("random")])

        var split = navigation(.split)
        split.select(.list(MainNavigation.activityId))
        split.show("general", parentId: "p1", on: .home)
        XCTAssertEqual(split.split, [.list(MainNavigation.activityId), .channel("general")])
        XCTAssertEqual(split.pendingThread, ThreadRef(channelId: "general", parentId: "p1"))
    }

    /// An activity row of a reply (2026-10-09): the thread alone over the activity, Back returns to the activity in one
    /// step (as from 「スレッド」); a top-level message still opens its conversation; the split keeps the pane.
    func testAnActivityReplyPushesItsThreadAloneOverTheActivity() {
        var nav = navigation(.tabs)
        nav.tab = .activity
        nav.showFromActivity("general", parentId: "p1", on: .activity)
        XCTAssertEqual(nav.paths[.activity], [.thread(channelId: "general", parentId: "p1")])
        XCTAssertEqual(nav.frontChannelId, "general")
        nav.back()
        XCTAssertEqual(nav.paths[.activity], [])
        nav.showFromActivity("random", parentId: nil, on: .activity)
        XCTAssertEqual(nav.paths[.activity], [.channel("random")])

        var split = navigation(.split)
        split.select(.list(MainNavigation.activityId))
        split.showFromActivity("general", parentId: "p1", on: .activity)
        XCTAssertEqual(split.split, [.list(MainNavigation.activityId), .channel("general")])
        XCTAssertEqual(split.pendingThread, ThreadRef(channelId: "general", parentId: "p1"))

        // Wider (an iPad's window): the thread goes to its conversation's pane.
        var wider = navigation(.tabs)
        wider.tab = .activity
        wider.showFromActivity("general", parentId: "p1", on: .activity)
        wider.setLayout(.split, isDm: isDm)
        XCTAssertEqual(wider.split, [.list(MainNavigation.activityId), .channel("general")])
        XCTAssertEqual(wider.pendingThread, ThreadRef(channelId: "general", parentId: "p1"))
    }

    /// The thread header's conversation link (2026-10-09): over its own conversation the thread is popped (no second
    /// copy of the conversation); alone over the activity the conversation takes its place, so Back still returns to
    /// the activity; the conversation in front already stays alone.
    func testTheThreadHeadersLinkShowsItsConversation() {
        var over = navigation(.tabs)
        over.show("general", parentId: "p1", on: .home)
        over.openThreadConversation("general", on: .home)
        XCTAssertEqual(over.paths[.home], [.channel("general")])

        var alone = navigation(.tabs)
        alone.tab = .activity
        alone.showFromActivity("general", parentId: "p1", on: .activity)
        alone.openThreadConversation("general", on: .activity)
        XCTAssertEqual(alone.paths[.activity], [.channel("general")])
        alone.back()
        XCTAssertEqual(alone.paths[.activity], [])

        // A thread over another conversation's screen (a list, another channel) is replaced, not popped to it.
        var other = navigation(.tabs)
        other.paths[.home] = [.channel("random"), .thread(channelId: "general", parentId: "p1")]
        other.openThreadConversation("general", on: .home)
        XCTAssertEqual(other.paths[.home], [.channel("random"), .channel("general")])

        // The detail column's stack in the split; the conversation in front already: nothing more.
        var split = navigation(.split)
        split.select(.list(MainNavigation.activityId))
        split.split.append(.thread(channelId: "general", parentId: "p1"))
        split.openThreadConversation("general", on: .activity)
        XCTAssertEqual(split.split, [.list(MainNavigation.activityId), .channel("general")])
        split.openThreadConversation("general", on: .activity)
        XCTAssertEqual(split.split, [.list(MainNavigation.activityId), .channel("general")])
    }

    func testAThreadScreenGoesToThePaneInTheSplitAndLeavesWithItsConversation() {
        var nav = navigation(.tabs)
        nav.tab = .activity
        nav.show("general", parentId: "p1", on: .activity)
        nav.setLayout(.split, isDm: isDm)
        XCTAssertEqual(nav.split, [.list(MainNavigation.activityId), .channel("general")])
        XCTAssertEqual(nav.pendingThread, ThreadRef(channelId: "general", parentId: "p1"))

        var gone = navigation(.tabs)
        gone.land("general", isDm: false, parentId: "p1")
        gone.dropChannels { $0 == "general" }
        XCTAssertEqual(gone.paths[.home], [])
    }

    func testSidebarSelectionReplacesTheDetailAndPushesStack() {
        var nav = navigation(.split)
        nav.select(.list(SavedView.selectionId))
        nav.push(.channel("general"), on: .home)
        XCTAssertEqual(nav.split, [.list(SavedView.selectionId), .channel("general")])
        XCTAssertEqual(nav.sidebarSelection, .list(SavedView.selectionId))
        nav.back()
        XCTAssertEqual(nav.split, [.list(SavedView.selectionId)])
        nav.back() // not past the sidebar's selection
        XCTAssertEqual(nav.split, [.list(SavedView.selectionId)])
        nav.select(.channel("random"))
        XCTAssertEqual(nav.split, [.channel("random")])
    }

    func testCompactToRegularKeepsTheOpenConversationAndItsThread() {
        var nav = navigation(.tabs)
        nav.select(.list(ThreadsListView.selectionId)) // the home tab's tile
        nav.push(.channel("general"), on: .home)
        nav.openThread = ThreadRef(channelId: "general", parentId: "p9")
        nav.setLayout(.split, isDm: isDm)
        XCTAssertEqual(nav.layout, .split)
        XCTAssertEqual(nav.split, [.list(ThreadsListView.selectionId), .channel("general")])
        XCTAssertEqual(nav.frontChannelId, "general")
        XCTAssertEqual(nav.pendingThread, ThreadRef(channelId: "general", parentId: "p9")) // opened again, in the pane
        XCTAssertNil(nav.openThread)
    }

    func testTabsMapToTheSplit() {
        var dmTab = navigation(.tabs)
        dmTab.tab = .dms
        dmTab.setLayout(.split, isDm: isDm)
        XCTAssertEqual(dmTab.split, [.list(MainNavigation.dmsId)]) // the DM list, not an empty detail

        var activity = navigation(.tabs)
        activity.tab = .activity
        activity.push(.channel("general"), on: .activity)
        activity.setLayout(.split, isDm: isDm)
        XCTAssertEqual(activity.split, [.list(MainNavigation.activityId), .channel("general")]) // Back: the activity

        var you = navigation(.tabs)
        you.tab = .you
        you.setLayout(.split, isDm: isDm)
        XCTAssertTrue(you.youSheet)
        XCTAssertEqual(you.split, [])

        var home = navigation(.tabs)
        home.setLayout(.split, isDm: isDm)
        XCTAssertEqual(home.split, [])
        XCTAssertNil(home.frontChannelId)
    }

    func testRegularToCompactPicksTheTab() {
        var dm = navigation(.split)
        dm.select(.channel("dm-2"))
        dm.setLayout(.tabs, isDm: isDm)
        XCTAssertEqual(dm.tab, .dms)
        XCTAssertEqual(dm.paths[.dms], [.channel("dm-2")])
        XCTAssertEqual(dm.frontChannelId, "dm-2")

        var channel = navigation(.split)
        channel.select(.list(FilesView.selectionId))
        channel.push(.channel("general"), on: .home)
        channel.setLayout(.tabs, isDm: isDm)
        XCTAssertEqual(channel.tab, .home)
        XCTAssertEqual(channel.paths[.home], [.list(FilesView.selectionId), .channel("general")])

        var dmList = navigation(.split)
        dmList.select(.list(MainNavigation.dmsId))
        dmList.push(.channel("dm-1"), on: .home)
        dmList.setLayout(.tabs, isDm: isDm)
        XCTAssertEqual(dmList.tab, .dms)
        XCTAssertEqual(dmList.paths[.dms], [.channel("dm-1")]) // the list is the DM tab's own first screen

        var activity = navigation(.split)
        activity.select(.list(MainNavigation.activityId))
        activity.setLayout(.tabs, isDm: isDm)
        XCTAssertEqual(activity.tab, .activity)
        XCTAssertEqual(activity.paths[.activity], [])

        var settings = navigation(.split)
        settings.select(.channel("general"))
        settings.youSheet = true
        settings.setLayout(.tabs, isDm: isDm)
        XCTAssertEqual(settings.tab, .you)
        XCTAssertFalse(settings.youSheet)

        var empty = navigation(.split)
        empty.tab = .activity
        empty.setLayout(.tabs, isDm: isDm)
        XCTAssertEqual(empty.tab, .home)
    }

    func testRoundTripKeepsTheScreens() {
        var nav = navigation(.tabs)
        nav.land("general", isDm: false)
        nav.openThread = ThreadRef(channelId: "general", parentId: "p1")
        nav.setLayout(.split, isDm: isDm)
        nav.pendingThread = nil // the conversation took it
        nav.openThread = ThreadRef(channelId: "general", parentId: "p1") // …and reports it open
        nav.setLayout(.tabs, isDm: isDm)
        XCTAssertEqual(nav.tab, .home)
        XCTAssertEqual(nav.paths[.home], [.channel("general")])
        XCTAssertEqual(nav.pendingThread, ThreadRef(channelId: "general", parentId: "p1"))
        // The same layout again changes nothing.
        let before = nav
        nav.setLayout(.tabs, isDm: isDm)
        XCTAssertEqual(nav, before)
    }

    func testAThreadOfAnotherConversationIsNotCarried() {
        var nav = navigation(.tabs)
        nav.land("general", isDm: false)
        nav.openThread = ThreadRef(channelId: "random", parentId: "p1")
        nav.frontChanged()
        XCTAssertNil(nav.openThread)
        nav.openThread = ThreadRef(channelId: "random", parentId: "p1")
        nav.setLayout(.split, isDm: isDm)
        XCTAssertNil(nav.pendingThread)
    }

    func testGoneConversationsLeaveEveryStack() {
        var nav = navigation(.split)
        nav.select(.list(SavedView.selectionId))
        nav.push(.channel("gone"), on: .home)
        nav.push(.channel("general"), on: .home)
        nav.paths[.dms] = [.channel("gone")]
        nav.dropChannels { $0 == "gone" }
        XCTAssertEqual(nav.split, [.list(SavedView.selectionId)])
        XCTAssertEqual(nav.paths[.dms], [])
    }

    func testListsLandAlone() {
        var split = navigation(.split)
        split.select(.channel("general"))
        split.landList(CalendarView.selectionId)
        XCTAssertEqual(split.split, [.list(CalendarView.selectionId)])
        var tabs = navigation(.tabs)
        tabs.tab = .dms
        tabs.landList(MyTasksView.selectionId)
        XCTAssertEqual(tabs.tab, .home)
        XCTAssertEqual(tabs.paths[.home], [.list(MyTasksView.selectionId)])
    }

    /// The split's detail stack does not follow several screens leaving its path at once, nor the screens over a first
    /// screen that changes (iOS 26, DRIVE.md §30.6): those changes build it again; a push or one screen back do not.
    func testTheSplitsStackIsBuiltAgainWhenSeveralScreensGoAtOnce() {
        var nav = navigation(.split)
        nav.select(.list(DriveLocationsView.selectionId))
        for id in ["root", "a", "b", "c"] { nav.openDriveFolder(id, on: .home) }
        let deep = nav.split
        // A breadcrumb two folders up, and the top folder's.
        nav.openDriveFolder("a", on: .home)
        XCTAssertEqual(nav.split, [.list("drive"), .drive("root"), .drive("a")])
        XCTAssertTrue(MainNavigation.splitStackRebuilds(from: deep, to: nav.split))
        let atA = nav.split
        nav.openDriveFolder("root", on: .home)
        XCTAssertFalse(MainNavigation.splitStackRebuilds(from: atA, to: nav.split), "one folder up: the stack pops it")
        // Pushes and Back.
        var pushed = nav
        pushed.openDriveFolder("x", on: .home)
        XCTAssertFalse(MainNavigation.splitStackRebuilds(from: nav.split, to: pushed.split))
        var back = pushed
        back.back()
        XCTAssertFalse(MainNavigation.splitStackRebuilds(from: pushed.split, to: back.split))
        // The sidebar (or a notification) over a pushed screen: a new first screen.
        var selected = pushed
        selected.select(.channel("general"))
        XCTAssertTrue(MainNavigation.splitStackRebuilds(from: pushed.split, to: selected.split))
        var landed = pushed
        landed.land("general", isDm: false)
        XCTAssertTrue(MainNavigation.splitStackRebuilds(from: pushed.split, to: landed.split))
        // A new first screen with nothing pushed: its own identity changes it.
        var plain = navigation(.split)
        plain.select(.channel("general"))
        let before = plain.split
        plain.select(.channel("random"))
        XCTAssertFalse(MainNavigation.splitStackRebuilds(from: before, to: plain.split))
        // A page's breadcrumb, likewise.
        var pages = navigation(.split)
        pages.landPage("p3", docsId: DocsView.selectionId)
        pages.openPage("p4", on: .home)
        pages.openPage("p5", on: .home)
        let deepPages = pages.split
        pages.openPage("p3", on: .home)
        XCTAssertEqual(pages.split, [.list(DocsView.selectionId), .page("p3")])
        XCTAssertTrue(MainNavigation.splitStackRebuilds(from: deepPages, to: pages.split))
    }
}
