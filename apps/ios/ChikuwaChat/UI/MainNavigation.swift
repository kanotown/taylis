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

    /// The conversation on screen (M34 (8): only it reads and is "open").
    var frontChannelId: String? {
        if case .channel(let id)? = front { return id }
        return nil
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
            paths[target] = [.channel(channelId)]
            tab = target
        }
        if let parentId { pendingThread = ThreadRef(channelId: channelId, parentId: parentId) }
    }

    /// A list (the calendar, the tasks) from a notification: on the home tab, or alone in the detail column.
    mutating func landList(_ id: String) {
        if layout == .split { split = [.list(id)]; youSheet = false } else { paths[.home] = [.list(id)]; tab = .home }
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
            guard let index = path.firstIndex(where: { if case .channel(let id) = $0 { gone(id) } else { false } }) else { return path }
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
        let thread = openThread
        if new == .split {
            let stack = paths[tab] ?? []
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
