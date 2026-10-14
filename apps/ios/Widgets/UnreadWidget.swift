import SwiftUI
import WidgetKit

/// The 未読・メンション widget: the app icon's count (unread DMs and mentions, SYNC_PROTOCOL.md §10.5) in the workspace
/// it is set to (by default the one open in the app); the medium one lists the conversations, each opening it. Lock
/// screen: round, rectangle and one line.
struct UnreadWidget: Widget {
    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: UnreadWidgetStore.widgetKind, intent: WidgetWorkspaceIntent.self, provider: UnreadTimelineProvider()) { entry in
            UnreadFamilyView(entry: entry)
        }
        .configurationDisplayName("未読・メンション")
        .description("メンションと DM の未読の数と、その会話。")
        .supportedFamilies([.systemSmall, .systemMedium, .accessoryCircular, .accessoryRectangular, .accessoryInline])
    }
}

private struct UnreadFamilyView: View {
    let entry: UnreadTimelineEntry
    @Environment(\.widgetFamily) private var family

    var body: some View { UnreadWidgetView(entry: entry, family: family) }
}

/// The snapshot the app wrote (it reloads the widget whenever the count or the conversations change); while the app is
/// away — or for a workspace that is not open — the count is checked with GET /sync/summary once the snapshot is 15
/// minutes old (the conversations stay the app's: there is no cheap call for them).
struct UnreadTimelineProvider: AppIntentTimelineProvider {
    static let refreshInterval: TimeInterval = 15 * 60

    func placeholder(in context: Context) -> UnreadTimelineEntry {
        UnreadTimelineEntry(date: Date(), snapshot: UnreadWidgetSamples.snapshot)
    }

    private func resolve(_ configuration: WidgetWorkspaceIntent) -> UnreadWidgetSnapshot? {
        UnreadWidgetStore.file.resolve(configuration.selection, workspace: { WidgetWorkspaces.signedInWorkspace(account: $0) }, seed: UnreadWidgetRules.seed)
    }

    func snapshot(for configuration: WidgetWorkspaceIntent, in context: Context) async -> UnreadTimelineEntry {
        let stored = resolve(configuration)
        if context.isPreview, stored == nil {
            return UnreadTimelineEntry(date: Date(), snapshot: UnreadWidgetSamples.snapshot)
        }
        return UnreadTimelineEntry(date: Date(), snapshot: stored, workspace: WidgetWorkspaces.header(configuration.selection, account: stored?.account))
    }

    func timeline(for configuration: WidgetWorkspaceIntent, in context: Context) async -> Timeline<UnreadTimelineEntry> {
        var snapshot = resolve(configuration)
        if let stored = snapshot, stored.needsRefresh() {
            snapshot = await UnreadWidgetActions.refresh(account: stored.account) ?? stored
        }
        // Signed out while the refresh was on its way: nothing of the account is drawn (WIDGETS.md).
        if let shown = snapshot, !AccountSessions.shared.isSignedIn(account: shown.account) { snapshot = nil }
        let now = Date()
        let entry = UnreadTimelineEntry(date: now, snapshot: snapshot, workspace: WidgetWorkspaces.header(configuration.selection, account: snapshot?.account))
        return Timeline(entries: [entry], policy: .after(now.addingTimeInterval(Self.refreshInterval)))
    }
}
