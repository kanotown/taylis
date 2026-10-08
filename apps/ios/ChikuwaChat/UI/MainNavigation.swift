import SwiftUI

/// iPad (MOBILE_UI.md §13): the phone's four tabs at a compact width (an iPhone, an iPad in a narrow Split View, Slide
/// Over or a small Stage Manager window), a Slack-like sidebar and conversation at a regular width.
enum MainLayout: Equatable {
    case tabs, split

    static func of(_ sizeClass: UserInterfaceSizeClass?) -> MainLayout { sizeClass == .regular ? .split : .tabs }
}

/// A thread of a conversation: the one open in it, or one to open once the conversation shows.
struct ThreadRef: Equatable {
    let channelId: String
    let parentId: String
}

/// Where MainView is, in either layout, and how it is carried across a change of layout (rotating, resizing a Stage
/// Manager window, a Split View divider): the open conversation, the screens over it and its open thread stay.
struct MainNavigation: Equatable {
    var layout: MainLayout = .tabs
    /// The tabs: the selected tab and each tab's stack of screens (M34).
    var tab: MainTab = .home
    var paths: [MainTab: [MainRoute]] = [:]
    /// The split: the detail column's stack; its first screen is what the sidebar selected.
    var split: [MainRoute] = []
    /// The split: 自分 (settings) as a sheet over it.
    var youSheet = false
    /// A thread for the conversation to open once it shows (a reply's notification, a revealed reply, a layout change).
    var pendingThread: ThreadRef?
    /// The thread open in the front conversation, as the conversation reports it (carried across a layout change).
    var openThread: ThreadRef?

    /// The DM tab's list and the activity, as the split's detail (the sidebar's 「すべての DM」 and 「アクティビティ」).
    static let dmsId = "split.dms"
    static let activityId = "split.activity"

    /// The split's sidebar (320) steps aside for the thread pane (400) where the conversation would keep less than
    /// about 460 pt: an iPad in portrait, a narrower Stage Manager window; a 13" or 11" iPad in landscape keeps all three.
    static let threeColumnWidth: CGFloat = 1180
    static func sidebarStepsAside(width: CGFloat) -> Bool { width > 0 && width < threeColumnWidth }

    /// The screen in front: the top of the selected tab's stack, or of the detail column.
    var front: MainRoute? { layout == .split ? split.last : paths[tab]?.last }

    /// The conversation on screen (M34 (8): only it reads and is "open"), or the one of the thread in front.
    var frontChannelId: String? {
        switch front {
        case .channel(let id)?, .thread(let id, _)?: id
        default: nil
        }
    }

    /// What the sidebar shows as selected.
    var sidebarSelection: MainRoute? { layout == .split ? split.first : nil }

    /// Every stack of screens, whichever layout (a conversation that left the store is taken off them all).
    var allStacks: [[MainRoute]] { Array(paths.values) + [split] }

    /// A screen over the one in front: on the given tab's stack, or the detail column's.
    mutating func push(_ route: MainRoute, on tab: MainTab) {
        if layout == .split { split.append(route) } else { paths[tab, default: []].append(route) }
    }

    /// The sidebar's tap: the detail column starts again from it.
    mutating func select(_ route: MainRoute) {
        if layout == .split { split = [route] } else { push(route, on: .home) }
    }

    /// From a notification, a permalink, a search result, a new DM (M34 (7)): a DM on the DM tab, a channel on the home
    /// tab, its stack replaced; in the split, the detail column shows it alone.
    mutating func land(_ channelId: String, isDm: Bool, parentId: String? = nil) {
        if layout == .split {
            split = [.channel(channelId)]
            youSheet = false
        } else {
            let target: MainTab = isDm ? .dms : .home
            paths[target] = Self.conversation(channelId, thread: parentId)
            tab = target
            return
        }
        if let parentId { pendingThread = ThreadRef(channelId: channelId, parentId: parentId) }
    }

    /// A revealed message (a list row: the activity, mentions, saved, the Times feed): its conversation over this tab's
    /// stack, a reply's thread over it. On the phone both are pushed at once and the thread slides in alone; the
    /// conversation opened its thread once it had appeared, two pushes one after the other (2026-10-06).
    mutating func show(_ channelId: String, parentId: String?, on tab: MainTab) {
        if layout == .split {
            split.append(.channel(channelId))
            if let parentId { pendingThread = ThreadRef(channelId: channelId, parentId: parentId) } // its pane
        } else {
            paths[tab, default: []] += Self.conversation(channelId, thread: parentId)
        }
    }

    /// An activity row (a mention, a reply, a reaction; MOBILE_UI.md §5): on the phone a reply's thread goes over the
    /// activity alone, so Back returns to the activity at once, as from 「スレッド」 (2026-10-09). With the conversation
    /// pushed under it, Back showed the conversation first and the activity only on a second Back. Anything else, and
    /// the split (the thread in the conversation's pane), as `show`.
    mutating func showFromActivity(_ channelId: String, parentId: String?, on tab: MainTab) {
        guard layout == .tabs, let parentId else { return show(channelId, parentId: parentId, on: tab) }
        paths[tab, default: []].append(.thread(channelId: channelId, parentId: parentId))
    }

    /// The thread header's conversation link (MOBILE_UI.md §6.7): the conversation in place of the thread in front. A
    /// thread pushed over its own conversation is popped back to it (not a second copy of it); one pushed alone (from
    /// the activity) gives its place to the conversation, so Back from it goes where the thread's Back went. Anything
    /// else in front gets the conversation pushed over it, unless it is that conversation already.
    mutating func openThreadConversation(_ channelId: String, on tab: MainTab) {
        var path = layout == .split ? split : paths[tab] ?? []
        if case .thread(let id, _)? = path.last, id == channelId { path.removeLast() }
        if path.last != .channel(channelId) { path.append(.channel(channelId)) }
        if layout == .split { split = path } else { paths[tab] = path }
    }

    /// A conversation's screens on a phone's stack: the conversation, and the thread over it.
    static func conversation(_ channelId: String, thread parentId: String?) -> [MainRoute] {
        [.channel(channelId)] + (parentId.map { [.thread(channelId: channelId, parentId: $0)] } ?? [])
    }

    /// A list (the calendar, the tasks) from a notification: on the home tab, or alone in the detail column.
    mutating func landList(_ id: String) {
        if layout == .split { split = [.list(id)]; youSheet = false } else { paths[.home] = [.list(id)]; tab = .home }
    }

    /// M122: a page from a notification: on the home tab over 「ドキュメント」 (Back: the tree), or in the detail column.
    mutating func landPage(_ pageId: String, docsId: String) {
        if layout == .split {
            split = [.list(docsId), .page(pageId)]
            youSheet = false
        } else {
            paths[.home] = [.list(docsId), .page(pageId)]
            tab = .home
        }
    }

    /// M122: a page opened from a page (a link, a breadcrumb, a child page): back to it when it is on the stack already
    /// (a breadcrumb is a way back, §9.2), else pushed over the one in front.
    mutating func openPage(_ pageId: String, on tab: MainTab) {
        var path = layout == .split ? split : paths[tab] ?? []
        if let index = path.lastIndex(of: .page(pageId)) {
            path = Array(path[...index])
        } else {
            path.append(.page(pageId))
        }
        if layout == .split { split = path } else { paths[tab] = path }
    }

    /// ⌘[ : one screen back (not past the detail column's first screen or a tab's root).
    mutating func back() {
        if layout == .split {
            if split.count > 1 { split.removeLast() }
        } else if !(paths[tab] ?? []).isEmpty {
            paths[tab]?.removeLast()
        }
    }

    /// Takes every screen of a conversation no longer in the store (and those over it) off the stacks.
    mutating func dropChannels(where gone: (String) -> Bool) {
        func cut(_ path: [MainRoute]) -> [MainRoute] {
            guard let index = path.firstIndex(where: {
                switch $0 {
                case .channel(let id), .thread(let id, _): gone(id)
                case .list, .page: false
                }
            }) else { return path }
            return Array(path[..<index])
        }
        for (key, path) in paths { paths[key] = cut(path) }
        split = cut(split)
    }

    /// The front conversation changed: a thread reported for another one is no longer open.
    mutating func frontChanged() {
        if let open = openThread, open.channelId != frontChannelId { openThread = nil }
    }

    /// Into the other layout, the screens in front carried over: the tab's stack becomes the detail column's (the DM
    /// tab's list and the activity as its first screen when they were under it), and back; the open thread is opened
    /// again in the new layout's conversation.
    mutating func setLayout(_ new: MainLayout, isDm: (String) -> Bool) {
        guard new != layout else { return }
        var thread = openThread
        if new == .split {
            // A thread pushed as its own screen goes to the conversation's pane.
            var stack = paths[tab] ?? []
            if case .thread(let channelId, let parentId)? = stack.last {
                thread = ThreadRef(channelId: channelId, parentId: parentId)
                // A thread alone over a list (from the activity): its conversation shows it in the pane.
                if !stack.dropLast().contains(.channel(channelId)) { stack[stack.count - 1] = .channel(channelId) }
            }
            stack.removeAll { if case .thread = $0 { true } else { false } }
            switch tab {
            case .home: split = stack
            case .dms: split = stack.isEmpty ? [.list(Self.dmsId)] : stack
            case .activity: split = [.list(Self.activityId)] + stack
            case .you:
                split = []
                youSheet = true
            }
        } else {
            if youSheet {
                tab = .you
                youSheet = false
            } else {
                switch split.first {
                case nil:
                    tab = .home
                    paths[.home] = []
                case .list(Self.dmsId)?:
                    tab = .dms
                    paths[.dms] = Array(split.dropFirst())
                case .list(Self.activityId)?:
                    tab = .activity
                    paths[.activity] = Array(split.dropFirst())
                case .channel(let id)? where isDm(id):
                    tab = .dms
                    paths[.dms] = split
                default:
                    tab = .home
                    paths[.home] = split
                }
            }
        }
        layout = new
        if let thread, thread.channelId == frontChannelId { pendingThread = thread }
        openThread = nil
    }
}

/// Whether a conversation shows its thread in a pane beside it (the split) or pushed over it (the phone's stack).
private struct ThreadInPaneKey: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {
    var threadInPane: Bool {
        get { self[ThreadInPaneKey.self] }
        set { self[ThreadInPaneKey.self] = newValue }
    }
}

/// The hardware keyboard's shortcuts (the app's menu; held ⌘ lists them on an iPad): MainView acts on them.
enum KeyCommand: String {
    case jump, compose, search, back, closeThread

    static let notification = Notification.Name("chikuwa.keyCommand")

    func post() { NotificationCenter.default.post(name: Self.notification, object: nil, userInfo: ["command": rawValue]) }
}

/// A popover at a regular width (an iPad), the sheet it was at a compact one: both are attached, so the view keeps its
/// identity (and its state) when the window is resized.
extension View {
    func adaptivePopover<Content: View>(isPresented: Binding<Bool>, @ViewBuilder content: @escaping () -> Content) -> some View {
        modifier(AdaptivePopover(isPresented: isPresented, popover: content))
    }
}

private struct AdaptivePopover<Popover: View>: ViewModifier {
    @Binding var isPresented: Bool
    let popover: () -> Popover
    @Environment(\.horizontalSizeClass) private var sizeClass

    func body(content: Content) -> some View {
        let regular = sizeClass == .regular
        content
            .sheet(isPresented: Binding(get: { isPresented && !regular }, set: { isPresented = $0 }), content: popover)
            .popover(isPresented: Binding(get: { isPresented && regular }, set: { isPresented = $0 })) {
                popover().frame(minWidth: 380, idealWidth: 420, minHeight: 460, idealHeight: 540)
            }
    }
}
