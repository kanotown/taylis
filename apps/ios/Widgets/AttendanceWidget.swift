import SwiftUI
import WidgetKit

/// The 在室状況 widget (docs/PRESENCE.md): my state, 「在室 n 人」 and the workspace; the small one has one button
/// (在室 ⇄ 帰宅), the medium one my first four states. Lock screen: round, rectangle and one line (no buttons).
struct AttendanceWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: AttendanceWidgetStore.widgetKind, provider: AttendanceTimelineProvider()) { entry in
            AttendanceFamilyView(entry: entry)
        }
        .configurationDisplayName("在室状況")
        .description("自分の在室状況と在室の人数。ボタンで切り替えられます。")
        .supportedFamilies([.systemSmall, .systemMedium, .accessoryCircular, .accessoryRectangular, .accessoryInline])
    }
}

private struct AttendanceFamilyView: View {
    let entry: AttendanceTimelineEntry
    @Environment(\.widgetFamily) private var family

    var body: some View { AttendanceWidgetView(entry: entry, family: family) }
}

/// The snapshot the app wrote; read again from the server when it is a few minutes old or the last try failed (the
/// widget then shows the server's board even while the app is not running). One entry, refreshed every 15 minutes
/// (WidgetKit's budget decides when exactly); the app reloads the widget whenever the board changes on screen.
struct AttendanceTimelineProvider: TimelineProvider {
    static let refreshInterval: TimeInterval = 15 * 60

    func placeholder(in context: Context) -> AttendanceTimelineEntry {
        AttendanceTimelineEntry(date: Date(), snapshot: AttendanceWidgetSamples.snapshot)
    }

    func getSnapshot(in context: Context, completion: @escaping (AttendanceTimelineEntry) -> Void) {
        let stored = AttendanceWidgetStore.current()
        completion(AttendanceTimelineEntry(date: Date(), snapshot: context.isPreview ? (stored ?? AttendanceWidgetSamples.snapshot) : stored))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<AttendanceTimelineEntry>) -> Void) {
        Task {
            var snapshot = AttendanceWidgetStore.current()
            if let stored = snapshot, stored.needsRefresh() {
                snapshot = await AttendanceWidgetActions.refresh(account: stored.account) ?? stored
            }
            let now = Date()
            completion(Timeline(entries: [AttendanceTimelineEntry(date: now, snapshot: snapshot)],
                                policy: .after(now.addingTimeInterval(Self.refreshInterval))))
        }
    }
}
