import SwiftUI
import WidgetKit

/// The 在室状況 widget (docs/PRESENCE.md): my state, who is in the room and the workspace; the small one has one button
/// (在室 ⇄ 帰宅), the medium one my first four states. Lock screen: round, rectangle and one line (no buttons). Each
/// placed widget shows the workspace it is set to (WidgetWorkspaceIntent; by default the one open in the app).
struct AttendanceWidget: Widget {
    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: AttendanceWidgetStore.widgetKind, intent: WidgetWorkspaceIntent.self, provider: AttendanceTimelineProvider()) { entry in
            AttendanceFamilyView(entry: entry)
        }
        .configurationDisplayName("在室状況")
        .description("自分の在室状況と在室の人。ボタンで切り替えられます。")
        .supportedFamilies([.systemSmall, .systemMedium, .accessoryCircular, .accessoryRectangular, .accessoryInline])
    }
}

private struct AttendanceFamilyView: View {
    let entry: AttendanceTimelineEntry
    @Environment(\.widgetFamily) private var family

    var body: some View { AttendanceWidgetView(entry: entry, family: family) }
}

/// The snapshot the app wrote (or, for a workspace it has not written one for, one started from its row); read again
/// from the server when it is a few minutes old or the last try failed (the widget then shows the server's board even
/// while the app is not running). One entry, refreshed every 15 minutes (WidgetKit's budget decides when exactly); the
/// app reloads the widget whenever the board changes on screen.
struct AttendanceTimelineProvider: AppIntentTimelineProvider {
    static let refreshInterval: TimeInterval = 15 * 60

    func placeholder(in context: Context) -> AttendanceTimelineEntry {
        AttendanceTimelineEntry(date: Date(), snapshot: AttendanceWidgetSamples.snapshot)
    }

    func snapshot(for configuration: WidgetWorkspaceIntent, in context: Context) async -> AttendanceTimelineEntry {
        let stored = AttendanceWidgetStore.resolve(configuration.selection)
        if context.isPreview, stored == nil || stored.map(AttendanceWidgetRules.isLoading) == true {
            return AttendanceTimelineEntry(date: Date(), snapshot: AttendanceWidgetSamples.snapshot)
        }
        return AttendanceTimelineEntry(date: Date(), snapshot: stored, workspace: WidgetWorkspaces.header(configuration.selection, account: stored?.account))
    }

    func timeline(for configuration: WidgetWorkspaceIntent, in context: Context) async -> Timeline<AttendanceTimelineEntry> {
        var snapshot = AttendanceWidgetStore.resolve(configuration.selection)
        if let stored = snapshot, stored.needsRefresh() {
            snapshot = await AttendanceWidgetActions.refresh(account: stored.account) ?? stored
        }
        // Signed out while the refresh was on its way: nothing of the account is drawn (WIDGETS.md).
        if let shown = snapshot, !AccountSessions.shared.isSignedIn(account: shown.account) { snapshot = nil }
        let now = Date()
        let entry = AttendanceTimelineEntry(date: now, snapshot: snapshot, workspace: WidgetWorkspaces.header(configuration.selection, account: snapshot?.account))
        return Timeline(entries: [entry], policy: .after(now.addingTimeInterval(Self.refreshInterval)))
    }
}
