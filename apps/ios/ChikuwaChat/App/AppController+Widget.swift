import Foundation
import WidgetKit

/// The app's side of the 在室状況 widget (Widgets/, ChikuwaChat/Widget/AttendanceWidgetData.swift): the open
/// workspace's board as a snapshot in the App Group, and the widget's link into 「在室状況」.
extension AppController {
    /// What the widget would show for the workspace on screen now; nil before the account is known.
    func attendanceWidgetSnapshot(now: Date = Date()) -> AttendanceWidgetSnapshot? {
        guard let workspace = activeWorkspace, let meId = store.me?.id ?? me?.id else { return nil }
        let role = store.me?.role ?? me?.role
        let board = AttendanceRules.visible(board: store.attendance, role: role) ? store.attendance : nil
        return Self.attendanceWidgetSnapshot(board: board, users: store.users.values, workspace: workspace, meId: meId, now: now)
    }

    /// The snapshot of a board (nil: off, or I am a guest): the same states and only the rows of the people the app
    /// counts (AttendanceRules.onBoard), so the widget's 「在室 n 人」 is the header chip's.
    static func attendanceWidgetSnapshot(board: AttendanceBoardOut?, users: some Sequence<UserPublic>, workspace: Workspace, meId: String,
                                         now: Date = Date()) -> AttendanceWidgetSnapshot {
        let onBoard = Set(users.filter(AttendanceRules.onBoard).map(\.id))
        let states = (board?.states ?? []).map {
            AttendanceWidgetState(id: $0.id, ownerId: $0.ownerId, label: $0.label, icon: $0.icon, emoji: $0.emoji, color: $0.color,
                                  kind: $0.kind, position: $0.position, archived: $0.archived)
        }
        let entries = (board?.entries ?? []).filter { onBoard.contains($0.userId) || $0.userId == meId }.map {
            AttendanceWidgetEntry(userId: $0.userId, stateId: $0.stateId, since: $0.since, note: $0.note)
        }
        return AttendanceWidgetSnapshot(
            serverUrl: workspace.serverUrl, account: workspace.account, workspaceName: workspace.name, userId: meId,
            available: board != nil, states: states, entries: entries,
            symbols: Dictionary(uniqueKeysWithValues: AttendanceIcons.catalogue.map { ($0.key, $0.sf) }),
            colors: AttendancePalette.badgeColors, updatedAt: now, problem: nil)
    }

    /// Writes the open workspace's snapshot (MainView calls it whenever the board, my account or the counts change,
    /// and when the app goes to the background) and reloads the widget and the control when it changed.
    func publishAttendanceWidget() {
        SharedContainer.saveLanguage(UILanguage.shared.effective.rawValue)
        guard let snapshot = attendanceWidgetSnapshot() else { return }
        if AttendanceWidgetStore.save(snapshot, active: true) { Self.reloadAttendanceWidgets() }
    }

    /// An account left this device: its snapshot goes (the widget falls back to another workspace or says to sign in).
    /// The 未読・メンション and 今日の予定・締切 widgets' snapshots of it go too.
    func forgetAttendanceWidget(account: String) {
        AttendanceWidgetStore.remove(account: account)
        Self.reloadAttendanceWidgets()
        if UnreadWidgetStore.file.remove(account: account) { WidgetCenter.shared.reloadTimelines(ofKind: UnreadWidgetStore.widgetKind) }
        if TodayWidgetStore.file.remove(account: account) { WidgetCenter.shared.reloadTimelines(ofKind: TodayWidgetStore.widgetKind) }
    }

    static func reloadAttendanceWidgets() {
        WidgetCenter.shared.reloadTimelines(ofKind: AttendanceWidgetStore.widgetKind)
        if #available(iOS 18.0, *) { ControlCenter.shared.reloadControls(ofKind: AttendanceWidgetStore.controlKind) }
    }

    /// A widget was tapped (WidgetLink: `chikuwachat://attendance|open|channel/<id>|calendar|tasks|event/<id>|task/<id>
    /// ?server=…`): its workspace comes on screen (switching if needed), then what it names opens, as a notification's tap
    /// opens it (an event or a task in its channel's tab, or the calendar / 「自分のタスク」 for my own). False: not a
    /// widget's link.
    @discardableResult
    func openWidgetLink(_ url: URL) -> Bool {
        guard let link = WidgetLink.parse(url) else { return false }
        Task {
            guard booted else {
                pendingWidgetLink = link
                return
            }
            await openFromWidget(link)
        }
        return true
    }

    /// After startup (a link that arrived while the app was starting).
    func openPendingWidgetLink() async {
        guard let link = pendingWidgetLink else { return }
        pendingWidgetLink = nil
        await openFromWidget(link)
    }

    private func openFromWidget(_ link: WidgetLink) async {
        if let server = link.server, let target = workspaces.first(where: { $0.serverUrl == server }), target.isSignedIn,
           server != activeServerUrl || screen != .main {
            await switchTo(server)
        }
        guard screen == .main else { return }
        switch link {
        case .attendance:
            PushCenter.shared.pendingAttendance = true
        case .open:
            break
        case .channel(let id, _):
            PushCenter.shared.pendingChannelId = id
            PushCenter.shared.pendingParentId = nil
        case .calendar:
            PushCenter.shared.pendingCalendar = true
        case .tasks:
            PushCenter.shared.pendingTasks = true
        case .event(let id, let channelId, _):
            await openNotification(PushPayload(channelId: channelId, kind: "calendar", eventId: id))
            return
        case .task(let id, let channelId, _):
            await openNotification(PushPayload(channelId: channelId, kind: "task", taskId: id))
            return
        }
        engine?.reconnectNow()
    }
}
