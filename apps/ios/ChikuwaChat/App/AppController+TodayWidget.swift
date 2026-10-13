import Foundation
import WidgetKit

/// The app's side of the 今日の予定・締切 widget (ChikuwaChat/Widget/TodayWidgetData.swift). The widget reads the events
/// and tasks itself; the app tells it which workspace is on screen and when something may have changed (its sync, a
/// calendar.* or task.* event, going to the background): the snapshot is marked stale and the widget reloaded, which
/// reads again.
extension AppController {
    /// The open workspace's snapshot with the change noted (what was read before stays shown until the new read).
    func todayWidgetSnapshot(now: Date = Date()) -> TodayWidgetSnapshot? {
        guard let workspace = activeWorkspace, let meId = store.me?.id ?? me?.id else { return nil }
        return Self.todayWidgetSnapshot(stored: TodayWidgetStore.file.snapshot(account: workspace.account), workspace: workspace, meId: meId, now: now)
    }

    static func todayWidgetSnapshot(stored: TodayWidgetSnapshot?, workspace: Workspace, meId: String, now: Date = Date()) -> TodayWidgetSnapshot {
        var snapshot = stored ?? TodayWidgetSnapshot(serverUrl: workspace.serverUrl, account: workspace.account, workspaceName: workspace.name,
                                                     userId: meId, updatedAt: now)
        snapshot.serverUrl = workspace.serverUrl
        snapshot.workspaceName = workspace.name
        if snapshot.userId != meId {
            snapshot.userId = meId
            snapshot.events = []
            snapshot.tasks = []
            snapshot.from = nil
        }
        snapshot.staleSince = now
        return snapshot
    }

    /// Something the widget shows may have changed: noted at once, the reload asked for a moment later (a burst of
    /// events asks once).
    /// (The mark is saved at once: should the app be suspended before the reload, the widget's next timeline reads again.)
    func todayWidgetChanged() {
        guard let snapshot = todayWidgetSnapshot() else { return }
        TodayWidgetStore.file.save(snapshot, active: true)
        todayWidgetReload?.cancel()
        todayWidgetReload = Task {
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            guard !Task.isCancelled else { return }
            WidgetCenter.shared.reloadTimelines(ofKind: TodayWidgetStore.widgetKind)
        }
    }
}
