import Foundation
import WidgetKit

/// The app's side of the 未読・メンション widget (ChikuwaChat/Widget/UnreadWidgetData.swift): the open workspace's
/// conversations that count on the app icon, as a snapshot in the App Group.
extension AppController {
    /// What the widget would show for the workspace on screen; nil before the account is known. `stamp` is its time
    /// (MainView compares snapshots with a fixed one).
    func unreadWidgetSnapshot(stamp: Date = Date(), now: Date = Date()) -> UnreadWidgetSnapshot? {
        guard let workspace = activeWorkspace, let meId = store.me?.id ?? me?.id else { return nil }
        let store = self.store
        return Self.unreadWidgetSnapshot(channels: store.channels.values, users: store.users, workspace: workspace, meId: meId,
                                         title: { channelTitle($0, store: store) }, stamp: stamp, now: now)
    }

    /// The conversations I am in, not archived, whose badge contribution is not 0 (ChannelState.badgeContribution:
    /// a DM's unread messages, else mentions; muted: mentions only). Their sum is GET /sync/summary's badge.
    static func unreadWidgetSnapshot(channels: some Sequence<ChannelState>, users: [String: UserPublic], workspace: Workspace, meId: String,
                                     title: (ChannelState) -> String, stamp: Date = Date(), now: Date = Date()) -> UnreadWidgetSnapshot {
        let rows = channels.compactMap { state -> UnreadWidgetRow? in
            guard state.isMember, !state.channel.archived else { return nil }
            let count = state.badgeContribution(now: now)
            guard count > 0 else { return nil }
            let last = state.channel.lastMessage
            // Who wrote last, where the name says something the row's name does not (not a 1:1 DM, not me, not the system).
            var sender: String?
            if let last, last.type == "user", last.senderId != meId, state.channel.type != "dm" {
                sender = users[last.senderId].map { $0.displayName.isEmpty ? $0.username : $0.displayName }
            }
            return UnreadWidgetRow(id: state.id, name: title(state), isDm: state.channel.isDm, count: count, mentions: state.mentionCount,
                                   lastAt: last?.createdAt ?? state.channel.lastMessageAt, lastSender: sender)
        }.sorted(by: UnreadWidgetRules.inOrder)
        return UnreadWidgetSnapshot(serverUrl: workspace.serverUrl, account: workspace.account, workspaceName: workspace.name, userId: meId,
                                    total: UnreadWidgetRules.rowsTotal(rows), rows: rows, rowsAt: stamp, updatedAt: stamp, problem: nil)
    }

    /// Writes the open workspace's snapshot (MainView calls it whenever the counts or the conversations change, and the
    /// app on going to the background) and reloads the widget when it changed.
    func publishUnreadWidget() {
        guard var snapshot = unreadWidgetSnapshot() else { return }
        // The same rows keep their time (only a change counts; the widget's own check may have left another count).
        if let old = UnreadWidgetStore.file.snapshot(account: snapshot.account), old.rows == snapshot.rows { snapshot.rowsAt = old.rowsAt }
        if UnreadWidgetStore.file.save(snapshot, active: true) { WidgetCenter.shared.reloadTimelines(ofKind: UnreadWidgetStore.widgetKind) }
    }
}
