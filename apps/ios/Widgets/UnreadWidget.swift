import SwiftUI
import WidgetKit

/// The 未読・メンション widget: the app icon's count (unread DMs and mentions, SYNC_PROTOCOL.md §10.5) in the workspace on
/// screen; the medium one lists the conversations, each opening it. Lock screen: round, rectangle and one line.
struct UnreadWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: UnreadWidgetStore.widgetKind, provider: UnreadTimelineProvider()) { entry in
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
/// away the count is checked with GET /sync/summary once the snapshot is 15 minutes old (the conversations stay the
/// app's: there is no cheap call for them).
struct UnreadTimelineProvider: TimelineProvider {
    static let refreshInterval: TimeInterval = 15 * 60

    func placeholder(in context: Context) -> UnreadTimelineEntry {
        UnreadTimelineEntry(date: Date(), snapshot: UnreadWidgetSamples.snapshot)
    }

    func getSnapshot(in context: Context, completion: @escaping (UnreadTimelineEntry) -> Void) {
        let stored = UnreadWidgetStore.file.current()
        completion(UnreadTimelineEntry(date: Date(), snapshot: context.isPreview ? (stored ?? UnreadWidgetSamples.snapshot) : stored))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<UnreadTimelineEntry>) -> Void) {
        Task {
            var snapshot = UnreadWidgetStore.file.current()
            if let stored = snapshot, stored.needsRefresh() {
                snapshot = await UnreadWidgetActions.refresh(account: stored.account) ?? stored
            }
            let now = Date()
            completion(Timeline(entries: [UnreadTimelineEntry(date: now, snapshot: snapshot)],
                                policy: .after(now.addingTimeInterval(Self.refreshInterval))))
        }
    }
}
