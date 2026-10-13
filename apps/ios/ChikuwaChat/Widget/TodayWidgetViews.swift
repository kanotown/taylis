import SwiftUI
import WidgetKit

// The 今日の予定・締切 widget's faces (Widgets/TodayWidget.swift configures it). Compiled into the app too, so the tests
// render them (TodayWidgetTests). Each entry's date is the moment drawn: its day's events and tasks, those already over
// dimmed (and left out first when they do not fit).

struct TodayTimelineEntry: TimelineEntry {
    let date: Date
    /// nil: the app has written none (nobody signed in yet).
    let snapshot: TodayWidgetSnapshot?
}

struct TodayWidgetView: View {
    let entry: TodayTimelineEntry
    let family: WidgetFamily
    var calendar: Calendar = .current

    var body: some View {
        content
            // Tapping outside a row opens the calendar of that workspace.
            .widgetURL(WidgetLink.calendar(server: entry.snapshot?.serverUrl).url)
            .environment(\.locale, WidgetLanguage.locale)
    }

    @ViewBuilder
    private var content: some View {
        let model = TodayWidgetModel(entry: entry, calendar: calendar)
        switch family {
        case .accessoryRectangular: TodayRectangularView(model: model)
        case .accessoryInline: TodayInlineView(model: model)
        case .systemMedium: TodayHomeView(model: model, size: .medium)
        case .systemLarge: TodayHomeView(model: model, size: .large)
        default: TodayHomeView(model: model, size: .small)
        }
    }
}

/// What one entry shows.
struct TodayWidgetModel {
    let snapshot: TodayWidgetSnapshot?
    let now: Date
    let calendar: Calendar
    let today: WidgetDay
    let events: [TodayWidgetEvent]
    let tasks: [TodayWidgetTask]

    init(entry: TodayTimelineEntry, calendar: Calendar) {
        snapshot = entry.snapshot
        now = entry.date
        self.calendar = calendar
        today = TodayWidgetRules.dayKey(entry.date, calendar)
        events = TodayWidgetRules.events(on: today, entry.snapshot?.events ?? [], calendar)
        tasks = TodayWidgetRules.tasks(entry.snapshot?.tasks ?? [], now: entry.date, calendar)
    }

    /// Whether the snapshot holds this day (the first read has come back, and not from before yesterday).
    var known: Bool {
        guard let from = snapshot?.from else { return false }
        return from <= today && today <= TodayWidgetRules.addDays(from, TodayWidgetRules.daysRead - 1, calendar)
    }

    var next: TodayWidgetEvent? { TodayWidgetRules.nextEvent(events, now: now, calendar) }
    var overdue: Int { TodayWidgetRules.overdueCount(snapshot?.tasks ?? [], now: now, calendar) }

    func isOverdue(_ task: TodayWidgetTask) -> Bool { TodayWidgetRules.isOverdue(task, today: today, now: now) }

    /// 「10月14日（水）」 in the widget's language.
    var dayLabel: String {
        now.formatted(Date.FormatStyle(date: .omitted, time: .omitted, locale: WidgetLanguage.locale, calendar: calendar,
                                       timeZone: calendar.timeZone).month(.abbreviated).day().weekday(.abbreviated))
    }

    func clock(_ date: Date) -> String {
        let p = calendar.dateComponents([.hour, .minute], from: date)
        return String(format: "%d:%02d", p.hour!, p.minute!)
    }

    /// The time on this day (CalendarDates.timeOnDay): 「終日」, 「14:00」 (its start), 「〜15:30」 (began earlier).
    func time(_ event: TodayWidgetEvent) -> String {
        if event.allDay { return widgetText("終日") }
        let days = TodayWidgetRules.eventDays(event, calendar)
        if days.first == today, let start = event.startsAt { return clock(start) }
        if days.last == today, let end = event.endsAt { return "〜" + clock(end) }
        return widgetText("終日")
    }

    /// A task's due on this day: 「期限切れ」 (with its date when it was another day), else its time, else nothing.
    func due(_ task: TodayWidgetTask) -> String? {
        if isOverdue(task) {
            let day = TodayWidgetRules.dueDay(task, calendar) ?? today
            if day == today, let at = task.dueAt { return widgetText("期限切れ") + " " + clock(at) }
            if day != today {
                let parts = day.split(separator: "-").compactMap { Int($0) }
                if parts.count == 3 { return widgetText("期限切れ") + " \(parts[1])/\(parts[2])" }
            }
            return widgetText("期限切れ")
        }
        return task.dueAt.map(clock)
    }
}

enum TodayWidgetSize { case small, medium, large }

/// The home screen's small, medium and large widgets.
struct TodayHomeView: View {
    let model: TodayWidgetModel
    let size: TodayWidgetSize

    var body: some View {
        Group {
            if let snapshot = model.snapshot {
                switch size {
                case .small: small(snapshot)
                case .medium: medium(snapshot)
                case .large: large(snapshot)
                }
            } else {
                VStack(alignment: .leading, spacing: 6) {
                    Text(verbatim: "Taylis").font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
                    Image(systemName: "calendar").font(.title2).foregroundStyle(.secondary).accessibilityHidden(true)
                    Text("Taylis を開いてサインインしてください").font(.footnote).foregroundStyle(.secondary).lineLimit(3)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            }
        }
        .containerBackground(for: .widget) { Color(.systemBackground) }
    }

    /// The day and the workspace (and why the list may be old).
    private func header(_ snapshot: TodayWidgetSnapshot, workspace: Bool) -> some View {
        HStack(spacing: 6) {
            Text(verbatim: model.dayLabel).font(.caption.weight(.bold)).foregroundStyle(.red).lineLimit(1)
            if workspace {
                Text(verbatim: snapshot.workspaceName).font(.caption2.weight(.semibold)).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer(minLength: 0)
            if let problem = snapshot.problem {
                Image(systemName: problem == .offline ? "wifi.exclamationmark" : "exclamationmark.triangle.fill")
                    .font(.caption2)
                    .foregroundStyle(.orange)
                    .accessibilityLabel(Text(problem == .offline ? "更新できません" : "サインインし直してください"))
            }
        }
    }

    // MARK: small: the next event and the tasks' count

    private func small(_ snapshot: TodayWidgetSnapshot) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            header(snapshot, workspace: false)
            if let next = model.next {
                HStack(alignment: .top, spacing: 6) {
                    RoundedRectangle(cornerRadius: 1.5).fill(Color(rgb: TodayWidgetRules.color(next.channelId))).frame(width: 3)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(verbatim: model.time(next)).font(.caption.weight(.semibold)).monospacedDigit()
                        Text(verbatim: next.title).font(.subheadline.weight(.bold)).lineLimit(2).privacySensitive()
                        if let channel = next.channelName {
                            Text(verbatim: "#" + channel).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                        }
                    }
                }
                .fixedSize(horizontal: false, vertical: true)
                let more = model.events.filter { !TodayWidgetRules.isOver($0, now: model.now) && $0.id != next.id }.count
                if more > 0 { Text("ほか \(more) 件").font(.caption2).foregroundStyle(.secondary) }
            } else {
                Text(model.known ? (model.events.isEmpty ? "今日の予定なし" : "今日の予定は終わりました") : "読み込み中")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .padding(.top, 4)
            }
            Spacer(minLength: 0)
            taskCount
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    /// 「期限のタスク 2」 (red with 「期限切れ 1」 when some are overdue), a link to the tasks.
    private var taskCount: some View {
        Link(destination: WidgetLink.tasks(server: model.snapshot?.serverUrl).url) {
            HStack(spacing: 4) {
                Image(systemName: model.overdue > 0 ? "exclamationmark.circle.fill" : "checklist")
                    .foregroundStyle(model.overdue > 0 ? Color.red : Color.secondary)
                if model.tasks.isEmpty {
                    Text("期限のタスクなし").foregroundStyle(.secondary)
                } else {
                    Text("期限のタスク \(model.tasks.count)")
                    if model.overdue > 0 { Text("（期限切れ \(model.overdue)）").foregroundStyle(.red) }
                }
            }
            .font(.caption2.weight(.semibold))
            .lineLimit(1)
            .minimumScaleFactor(0.8)
            .foregroundStyle(Color.primary)
        }
    }

    // MARK: medium: events | tasks

    private func medium(_ snapshot: TodayWidgetSnapshot) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            header(snapshot, workspace: true)
            HStack(alignment: .top, spacing: 10) {
                eventList(snapshot, limit: TodayWidgetRules.mediumEvents, compact: true)
                    .frame(maxWidth: .infinity, alignment: .topLeading)
                Divider()
                taskList(snapshot, limit: TodayWidgetRules.mediumTasks, compact: true)
                    .frame(maxWidth: .infinity, alignment: .topLeading)
            }
            .frame(maxHeight: .infinity, alignment: .top)
        }
    }

    // MARK: large: events, then tasks

    private func large(_ snapshot: TodayWidgetSnapshot) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            header(snapshot, workspace: true)
            eventList(snapshot, limit: TodayWidgetRules.largeEvents, compact: false)
            Divider()
            taskList(snapshot, limit: TodayWidgetRules.largeTasks, compact: false)
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private func sectionTitle(_ title: LocalizedStringKey, count: Int, link: WidgetLink) -> some View {
        Link(destination: link.url) {
            HStack(spacing: 4) {
                Text(title)
                if count > 0 { Text(verbatim: "\(count)").monospacedDigit() }
            }
            .font(.caption2.weight(.semibold))
        }
        // A link's label takes the tint otherwise.
        .foregroundStyle(Color.secondary)
    }

    private func eventList(_ snapshot: TodayWidgetSnapshot, limit: Int, compact: Bool) -> some View {
        let shown = TodayWidgetRules.visible(model.events, now: model.now, limit: limit)
        return VStack(alignment: .leading, spacing: compact ? 3 : 5) {
            sectionTitle("予定", count: model.events.count, link: .calendar(server: snapshot.serverUrl))
            if shown.isEmpty {
                Text(model.known ? "今日の予定なし" : "読み込み中").font(.caption).foregroundStyle(.secondary)
            }
            ForEach(shown) { event in
                Link(destination: TodayWidgetRules.link(event, server: snapshot.serverUrl).url) { eventRow(event, compact: compact).foregroundStyle(Color.primary) }
            }
            if model.events.count > shown.count {
                Text("ほか \(model.events.count - shown.count) 件").font(.caption2).foregroundStyle(.secondary)
            }
        }
    }

    private func eventRow(_ event: TodayWidgetEvent, compact: Bool) -> some View {
        let over = TodayWidgetRules.isOver(event, now: model.now)
        return HStack(alignment: .center, spacing: 5) {
            RoundedRectangle(cornerRadius: 1.5).fill(Color(rgb: TodayWidgetRules.color(event.channelId))).frame(width: 3, height: compact ? 14 : 28)
            Text(verbatim: model.time(event))
                .font(.caption2.weight(.semibold))
                .monospacedDigit()
                .lineLimit(1)
                .frame(width: compact ? 40 : 48, alignment: .leading)
                .minimumScaleFactor(0.7)
            VStack(alignment: .leading, spacing: 0) {
                Text(verbatim: event.title).font(.caption.weight(compact ? .medium : .semibold)).lineLimit(1).privacySensitive()
                if !compact, let channel = event.channelName {
                    Text(verbatim: "#" + channel).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            Spacer(minLength: 0)
        }
        .opacity(over ? 0.45 : 1)
        .contentShape(Rectangle())
    }

    private func taskList(_ snapshot: TodayWidgetSnapshot, limit: Int, compact: Bool) -> some View {
        let shown = Array(model.tasks.prefix(limit))
        return VStack(alignment: .leading, spacing: compact ? 3 : 5) {
            sectionTitle("期限のタスク", count: model.tasks.count, link: .tasks(server: snapshot.serverUrl))
            if shown.isEmpty {
                Text(model.known ? "期限のタスクなし" : "読み込み中").font(.caption).foregroundStyle(.secondary)
            }
            ForEach(shown) { task in
                Link(destination: TodayWidgetRules.link(task, server: snapshot.serverUrl).url) { taskRow(task, compact: compact).foregroundStyle(Color.primary) }
            }
            if model.tasks.count > shown.count {
                Text("ほか \(model.tasks.count - shown.count) 件").font(.caption2).foregroundStyle(.secondary)
            }
        }
    }

    private func taskRow(_ task: TodayWidgetTask, compact: Bool) -> some View {
        let overdue = model.isOverdue(task)
        return HStack(alignment: .center, spacing: 5) {
            Image(systemName: "circle")
                .font(.system(size: compact ? 10 : 12, weight: .semibold))
                .foregroundStyle(overdue ? Color.red : Color.secondary)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 0) {
                Text(verbatim: task.title).font(.caption.weight(compact ? .medium : .semibold)).lineLimit(1).privacySensitive()
                if !compact, let channel = task.channelName {
                    Text(verbatim: "#" + channel).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            Spacer(minLength: 2)
            if let due = model.due(task) {
                Text(verbatim: due)
                    .font(.caption2.weight(overdue ? .bold : .regular))
                    .monospacedDigit()
                    .foregroundStyle(overdue ? Color.red : Color.secondary)
                    .lineLimit(1)
                    .layoutPriority(1)
            }
        }
        .frame(minHeight: compact ? 14 : 28)
        .contentShape(Rectangle())
    }
}

/// Lock screen, rectangle: the next event (time, title, channel) and the tasks' count.
struct TodayRectangularView: View {
    let model: TodayWidgetModel

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            if model.snapshot == nil {
                Text("今日の予定").font(.headline)
                Text("Taylis を開いてサインインしてください").font(.caption).lineLimit(2)
            } else {
                if let next = model.next {
                    Text(verbatim: model.time(next)).font(.caption.weight(.semibold)).monospacedDigit()
                    Text(verbatim: next.title).font(.headline).lineLimit(1).privacySensitive()
                } else {
                    Text(verbatim: model.dayLabel).font(.caption.weight(.semibold))
                    Text(model.known ? (model.events.isEmpty ? "今日の予定なし" : "今日の予定は終わりました") : "読み込み中").font(.headline).lineLimit(1)
                }
                if model.tasks.isEmpty {
                    Text("期限のタスクなし").font(.caption).foregroundStyle(.secondary)
                } else {
                    Text("期限のタスク \(model.tasks.count)").font(.caption)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .containerBackground(for: .widget) { Color.clear }
    }
}

/// Lock screen, one line: 「14:00 ゼミ」, else 「今日の予定なし」.
struct TodayInlineView: View {
    let model: TodayWidgetModel

    var body: some View {
        if let next = model.next {
            Label {
                Text(verbatim: "\(model.time(next)) \(next.title)")
            } icon: {
                Image(systemName: "calendar")
            }
        } else if !model.tasks.isEmpty {
            Label { Text("期限のタスク \(model.tasks.count)") } icon: { Image(systemName: "checklist") }
        } else {
            Label { Text("今日の予定なし") } icon: { Image(systemName: "calendar") }
        }
    }
}

/// The widget gallery's picture and the placeholder: a seminar day.
enum TodayWidgetSamples {
    static func snapshot(now: Date = Date(), calendar: Calendar = .current) -> TodayWidgetSnapshot {
        let start = calendar.startOfDay(for: now)
        func at(_ hour: Int, _ minute: Int = 0) -> Date { start.addingTimeInterval(TimeInterval(hour * 3600 + minute * 60)) }
        let today = TodayWidgetRules.dayKey(now, calendar)
        let events = [
            TodayWidgetEvent(id: "e1", title: widgetText("ゼミ"), allDay: false, startsAt: at(13), endsAt: at(15), channelId: "c1", channelName: "seminar"),
            TodayWidgetEvent(id: "e2", title: widgetText("輪講"), allDay: false, startsAt: at(16, 30), endsAt: at(17, 30), channelId: "c2", channelName: "reading"),
        ]
        let tasks = [TodayWidgetTask(id: "t1", title: widgetText("発表資料"), channelId: "c1", channelName: "seminar", dueOn: today)]
        return TodayWidgetSnapshot(serverUrl: "", account: "", workspaceName: "Taylis", userId: "me", events: events, tasks: tasks, from: today,
                                   staleSince: nil, updatedAt: .distantFuture, problem: nil)
    }
}
