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

    func testLandingInEachLayout() {
        var tabs = navigation(.tabs)
        tabs.land("dm-1", isDm: true)
        XCTAssertEqual(tabs.tab, .dms)
        XCTAssertEqual(tabs.paths[.dms], [.channel("dm-1")])
        tabs.land("general", isDm: false, parentId: "p1")
        XCTAssertEqual(tabs.tab, .home)
        XCTAssertEqual(tabs.frontChannelId, "general")
        XCTAssertEqual(tabs.pendingThread, ThreadRef(channelId: "general", parentId: "p1"))

        var split = navigation(.split)
        split.youSheet = true
        split.land("dm-1", isDm: true)
        XCTAssertEqual(split.split, [.channel("dm-1")])
        XCTAssertFalse(split.youSheet) // a notification's conversation is not left under the settings
        XCTAssertEqual(split.frontChannelId, "dm-1")
        XCTAssertEqual(split.sidebarSelection, .channel("dm-1"))
        XCTAssertTrue(split.paths.isEmpty) // the tabs' stacks are not touched
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
}
