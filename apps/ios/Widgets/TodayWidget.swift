import SwiftUI
import WidgetKit

/// The 今日の予定・締切 widget: today's events (mine and my channels') and my tasks due today or overdue. Small: the next
/// event and the tasks' count; medium: both lists side by side; large: both, longer. Lock screen: rectangle and one line.
struct TodayWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: TodayWidgetStore.widgetKind, provider: TodayTimelineProvider()) { entry in
            TodayFamilyView(entry: entry)
        }
        .configurationDisplayName("今日の予定・締切")
        .description("今日の予定と、今日が期限・期限切れの自分のタスク。")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .accessoryRectangular, .accessoryInline])
    }
}

private struct TodayFamilyView: View {
    let entry: TodayTimelineEntry
    @Environment(\.widgetFamily) private var family

    var body: some View { TodayWidgetView(entry: entry, family: family) }
}

/// Reads today's and tomorrow's events and my tasks with the shared tokens when the snapshot is stale (the app saw a
/// change), old, or of another day; then one entry now and one at every start, end, due time and midnight, so the face
/// moves on (and rolls over to the next day) without the app. Read again every half hour.
struct TodayTimelineProvider: TimelineProvider {
    func placeholder(in context: Context) -> TodayTimelineEntry {
        TodayTimelineEntry(date: Date(), snapshot: TodayWidgetSamples.snapshot())
    }

    func getSnapshot(in context: Context, completion: @escaping (TodayTimelineEntry) -> Void) {
        let stored = TodayWidgetStore.file.current()
        // The gallery: what was read, else the sample (not an empty 「読み込み中」).
        let preview = stored.flatMap { $0.from == nil ? nil : $0 } ?? TodayWidgetSamples.snapshot()
        completion(TodayTimelineEntry(date: Date(), snapshot: context.isPreview ? preview : stored))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<TodayTimelineEntry>) -> Void) {
        Task {
            var snapshot = TodayWidgetStore.file.current()
            if let stored = snapshot, TodayWidgetRules.needsRefresh(stored) {
                snapshot = await TodayWidgetActions.refresh(account: stored.account) ?? stored
            }
            let now = Date()
            let entries = TodayWidgetRules.entryDates(snapshot, now: now).map { TodayTimelineEntry(date: $0, snapshot: snapshot) }
            completion(Timeline(entries: entries, policy: .after(now.addingTimeInterval(TodayWidgetRules.refreshInterval))))
        }
    }
}
