import SwiftUI
import WidgetKit

// The 今日の予定・締切 widget's faces (Widgets/TodayWidget.swift configures it). Compiled into the app too, so the tests
// render them (TodayWidgetTests). Each entry's date is the moment drawn: its day's events and tasks, those already over
// dimmed (and left out first when they do not fit).

struct TodayTimelineEntry: TimelineEntry {
    let date: Date
    /// nil: nothing to show (nobody signed in yet, or the chosen workspace signed out).
    let snapshot: TodayWidgetSnapshot?
    /// The workspace's row for the header.
    var workspace: Workspace? = nil
}

struct TodayWidgetView: View {
    let entry: TodayTimelineEntry
    let family: WidgetFamily
    var calendar: Calendar = .current

    var body: some View {
        content
            // Tapping outside a row opens the calendar of that workspace.
            .widgetURL(WidgetLink.calendar(server: entry.snapshot?.serverUrl ?? entry.workspace?.serverUrl).url)
            .environment(\.locale, WidgetLanguage.locale)
            .dynamicTypeSize(...DynamicTypeSize.xLarge)
    }

    @ViewBuilder
    private var content: some View {
        let model = TodayWidgetModel(entry: entry, calendar: calendar)
        switch family {
        case .accessoryRectangular: TodayRectangularView(model: model)
        case .accessoryInline: TodayInlineView(model: model)
        case .systemMedium: TodayHomeView(model: model, workspace: entry.workspace, size: .medium)
        case .systemLarge: TodayHomeView(model: model, workspace: entry.workspace, size: .large)
        default: TodayHomeView(model: model, workspace: entry.workspace, size: .small)
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

    /// 「10/14(水)」: the small widget's header.
    var shortDayLabel: String {
        now.formatted(Date.FormatStyle(date: .omitted, time: .omitted, locale: WidgetLanguage.locale, calendar: calendar,
                                       timeZone: calendar.timeZone).month(.defaultDigits).day().weekday(.abbreviated))
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

    /// From when to when on this day: 「終日」, 「13:00–15:00」, 「22:00〜」 (goes on past midnight), 「〜12:00」 (began
    /// earlier).
    func range(_ event: TodayWidgetEvent) -> String {
        guard !event.allDay, let start = event.startsAt else { return widgetText("終日") }
        let days = TodayWidgetRules.eventDays(event, calendar)
        if days.first == today {
            guard let end = event.endsAt, end > start else { return clock(start) }
            return days.last == today ? "\(clock(start))–\(clock(end))" : clock(start) + "〜"
        }
        return time(event)
    }

    /// A task's due on this day: 「期限切れ」 (with its date when it was another day, its time when today), else its time,
    /// else nothing. `compact` (the medium widget's column) leaves the word out: the red circle and colour say it.
    func due(_ task: TodayWidgetTask, compact: Bool = false) -> String? {
        if isOverdue(task) {
            let word = compact ? nil : widgetText("期限切れ")
            let day = TodayWidgetRules.dueDay(task, calendar) ?? today
            var when: String?
            if day == today, let at = task.dueAt { when = clock(at) }
            if day != today {
                let parts = day.split(separator: "-").compactMap { Int($0) }
                if parts.count == 3 { when = "\(parts[1])/\(parts[2])" }
            }
            let text = [word, when].compactMap { $0 }.joined(separator: " ")
            return text.isEmpty ? widgetText("期限切れ") : text
        }
        return task.dueAt.map(clock)
    }
}

enum TodayWidgetSize { case small, medium, large }

/// The home screen's small, medium and large widgets.
struct TodayHomeView: View {
    let model: TodayWidgetModel
    var workspace: Workspace? = nil
    let size: TodayWidgetSize
    @WidgetFullColor private var fullColor
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        Group {
            if let snapshot = model.snapshot {
                VStack(alignment: .leading, spacing: 0) {
                    header(snapshot)
                    switch size {
                    case .small: small(snapshot)
                    case .medium: medium(snapshot)
                    case .large: large(snapshot)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            } else {
                WidgetMessageFace.signIn(workspace, compact: size == .small)
            }
        }
        .containerBackground(for: .widget) { Color(.systemBackground) }
    }

    /// The workspace, and on the right the day (and why the list may be old).
    private func header(_ snapshot: TodayWidgetSnapshot) -> some View {
        WidgetHeader(workspace: workspace ?? Workspace(serverUrl: snapshot.serverUrl, name: snapshot.workspaceName, username: ""),
                     name: snapshot.workspaceName) {
            HStack(spacing: 4) {
                if let problem = snapshot.problem { WidgetProblemIcon(problem: problem) }
                Text(verbatim: size == .small ? model.shortDayLabel : model.dayLabel)
                    .font(.caption.weight(.bold))
                    .foregroundStyle(fullColor ? Color.red : Color.primary)
                    .lineLimit(1)
                    .fixedSize()
                    .widgetAccentable()
            }
        }
    }

    private func ink(_ rgb: UInt32) -> Color { fullColor ? Color.widgetInk(rgb, dark: scheme == .dark) : Color.primary }

    /// A calendar's colour bar (a soft primary one in the tinted modes, so it does not vanish).
    private func bar(_ event: TodayWidgetEvent, height: CGFloat? = nil) -> some View {
        RoundedRectangle(cornerRadius: 2, style: .continuous)
            .fill(fullColor ? Color(rgb: TodayWidgetRules.color(event.channelId)) : Color.primary.opacity(0.55))
            .frame(width: 4, height: height)
            .widgetAccentable()
    }

    /// Nothing today: an icon and its words (centred in what is left).
    private func emptyDay(withTasksLine: Bool) -> some View {
        VStack(spacing: 6) {
            Image(systemName: model.known ? "calendar.badge.checkmark" : "arrow.triangle.2.circlepath")
                .font(.system(size: 26, weight: .regular))
                .foregroundStyle(fullColor ? Color.red.opacity(0.85) : Color.primary)
                .widgetAccentable()
                .accessibilityHidden(true)
            Text(model.known ? (model.events.isEmpty ? "今日の予定はありません" : "今日の予定は終わりました") : "読み込み中")
                .font(.subheadline.weight(.semibold))
                .multilineTextAlignment(.center)
            if withTasksLine && model.known {
                Text("期限のタスクもありません").font(.caption).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: small: the next event and the tasks' count

    @ViewBuilder
    private func small(_ snapshot: TodayWidgetSnapshot) -> some View {
        if let next = model.next {
            Spacer(minLength: 8)
            Link(destination: TodayWidgetRules.link(next, server: snapshot.serverUrl).url) {
                HStack(alignment: .top, spacing: 8) {
                    bar(next)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(verbatim: model.range(next))
                            .font(.caption.weight(.semibold))
                            .monospacedDigit()
                            .foregroundStyle(ink(TodayWidgetRules.color(next.channelId)))
                            .lineLimit(1)
                            .minimumScaleFactor(0.8)
                        Text(verbatim: next.title).font(.headline).lineLimit(2).privacySensitive()
                        if let channel = next.channelName {
                            Text(verbatim: "#" + channel).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                        }
                    }
                }
                .fixedSize(horizontal: false, vertical: true)
                .foregroundStyle(Color.primary)
            }
            let more = model.events.filter { !TodayWidgetRules.isOver($0, now: model.now) && $0.id != next.id }.count
            if more > 0 {
                Text("ほか \(more) 件").font(.caption2.weight(.medium)).foregroundStyle(.secondary).padding(.top, 4).padding(.leading, 12)
            }
            Spacer(minLength: 6)
        } else {
            emptyDay(withTasksLine: false)
        }
        taskCount
    }

    /// 「タスク 2 · 期限切れ 1」 in a soft row, a link to the tasks.
    private var taskCount: some View {
        Link(destination: WidgetLink.tasks(server: model.snapshot?.serverUrl).url) {
            HStack(spacing: 5) {
                Image(systemName: model.tasks.isEmpty ? "checkmark.circle" : "checklist")
                    .foregroundStyle(fullColor && model.overdue > 0 ? Color.red : Color.secondary)
                    .widgetAccentable()
                if model.tasks.isEmpty {
                    Text("期限のタスクなし").foregroundStyle(.secondary)
                } else {
                    Text("\(model.tasks.count) 件")
                    if model.overdue > 0 {
                        Text("期限切れ \(model.overdue)").foregroundStyle(fullColor ? Color.red : Color.primary)
                    }
                }
                Spacer(minLength: 0)
            }
            .font(.caption.weight(.semibold))
            .monospacedDigit()
            .lineLimit(1)
            .minimumScaleFactor(0.8)
            .foregroundStyle(Color.primary)
            .padding(.horizontal, 8)
            .frame(height: 28)
            .background(RoundedRectangle(cornerRadius: 9, style: .continuous).fill(Color.primary.opacity(fullColor ? 0.05 : 0.1)))
        }
    }

    // MARK: medium: events | tasks

    @ViewBuilder
    private func medium(_ snapshot: TodayWidgetSnapshot) -> some View {
        if model.events.isEmpty && model.tasks.isEmpty {
            emptyDay(withTasksLine: true)
        } else {
            Spacer(minLength: WidgetMetrics.gapUnderHeader).frame(maxHeight: WidgetMetrics.gapUnderHeader)
            HStack(alignment: .top, spacing: 12) {
                eventList(snapshot, limit: TodayWidgetRules.mediumEvents, compact: true)
                    .frame(maxWidth: .infinity, alignment: .topLeading)
                Rectangle().fill(Color.primary.opacity(0.1)).frame(width: 1)
                taskList(snapshot, limit: TodayWidgetRules.mediumTasks, compact: true)
                    .frame(maxWidth: .infinity, alignment: .topLeading)
            }
            .frame(maxHeight: .infinity, alignment: .top)
        }
    }

    // MARK: large: events, then tasks

    @ViewBuilder
    private func large(_ snapshot: TodayWidgetSnapshot) -> some View {
        if model.events.isEmpty && model.tasks.isEmpty {
            emptyDay(withTasksLine: true)
        } else {
            let limits = TodayWidgetRules.largeLimits(events: model.events.count, tasks: model.tasks.count)
            VStack(alignment: .leading, spacing: 10) {
                eventList(snapshot, limit: max(limits.events, 1), compact: false)
                Rectangle().fill(Color.primary.opacity(0.1)).frame(height: 1)
                taskList(snapshot, limit: max(limits.tasks, 1), compact: false)
                Spacer(minLength: 0)
            }
            .padding(.top, WidgetMetrics.gapUnderHeader)
        }
    }

    /// 「予定 5」 on the left, 「ほか 2 件」 on the right when not all fit; a link to the list.
    private func sectionTitle(_ title: LocalizedStringKey, count: Int, hidden: Int, link: WidgetLink) -> some View {
        Link(destination: link.url) {
            HStack(spacing: 4) {
                Text(title)
                if count > 0 { Text(verbatim: "\(count)").monospacedDigit() }
                Spacer(minLength: 4)
                if hidden > 0 { Text("ほか \(hidden) 件").fontWeight(.medium) }
            }
            .font(.caption2.weight(.bold))
            .lineLimit(1)
        }
        // A link's label takes the tint otherwise.
        .foregroundStyle(Color.secondary)
    }

    private func eventList(_ snapshot: TodayWidgetSnapshot, limit: Int, compact: Bool) -> some View {
        let shown = TodayWidgetRules.visible(model.events, now: model.now, limit: limit)
        return VStack(alignment: .leading, spacing: compact ? 5 : 4) {
            sectionTitle("予定", count: model.events.count, hidden: model.events.count - shown.count, link: .calendar(server: snapshot.serverUrl))
            if shown.isEmpty {
                Text(model.known ? "今日の予定なし" : "読み込み中").font(.caption).foregroundStyle(.secondary)
            }
            ForEach(shown) { event in
                Link(destination: TodayWidgetRules.link(event, server: snapshot.serverUrl).url) { eventRow(event, compact: compact).foregroundStyle(Color.primary) }
            }
        }
    }

    private func eventRow(_ event: TodayWidgetEvent, compact: Bool) -> some View {
        let over = TodayWidgetRules.isOver(event, now: model.now)
        return HStack(alignment: .center, spacing: 6) {
            bar(event, height: compact ? 16 : 30)
            Text(verbatim: model.time(event))
                .font(.caption2.weight(.semibold))
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.7)
                .frame(width: compact ? 40 : 46, alignment: .leading)
            VStack(alignment: .leading, spacing: 0) {
                Text(verbatim: event.title).font(compact ? .caption.weight(.medium) : .footnote.weight(.semibold)).lineLimit(1).privacySensitive()
                if !compact, let channel = event.channelName {
                    Text(verbatim: "#" + channel).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            Spacer(minLength: 0)
        }
        .frame(height: compact ? 18 : 30)
        .opacity(over ? 0.4 : 1)
        .contentShape(Rectangle())
    }

    private func taskList(_ snapshot: TodayWidgetSnapshot, limit: Int, compact: Bool) -> some View {
        let shown = Array(model.tasks.prefix(limit))
        return VStack(alignment: .leading, spacing: compact ? 5 : 4) {
            sectionTitle("期限のタスク", count: model.tasks.count, hidden: model.tasks.count - shown.count, link: .tasks(server: snapshot.serverUrl))
            if shown.isEmpty {
                Text(model.known ? "期限のタスクなし" : "読み込み中").font(.caption).foregroundStyle(.secondary)
            }
            ForEach(shown) { task in
                Link(destination: TodayWidgetRules.link(task, server: snapshot.serverUrl).url) { taskRow(task, compact: compact).foregroundStyle(Color.primary) }
            }
        }
    }

    private func taskRow(_ task: TodayWidgetTask, compact: Bool) -> some View {
        let overdue = model.isOverdue(task)
        let alert = fullColor ? Color.red : Color.primary
        return HStack(alignment: .center, spacing: 6) {
            Image(systemName: "square")
                .font(.system(size: compact ? 12 : 15, weight: .medium))
                .foregroundStyle(overdue ? alert : Color.secondary)
                .widgetAccentable(overdue)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 0) {
                Text(verbatim: task.title).font(compact ? .caption.weight(.medium) : .footnote.weight(.semibold)).lineLimit(1).privacySensitive()
                if !compact, let channel = task.channelName {
                    Text(verbatim: "#" + channel).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            Spacer(minLength: 2)
            if let due = model.due(task, compact: compact) {
                Text(verbatim: due)
                    .font(.caption2.weight(overdue ? .bold : .medium))
                    .monospacedDigit()
                    .foregroundStyle(overdue ? alert : Color.secondary)
                    .lineLimit(1)
                    .layoutPriority(1)
                    .widgetAccentable(overdue)
            }
        }
        .frame(height: compact ? 18 : 30)
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
                    HStack(spacing: 4) {
                        Image(systemName: "calendar").widgetAccentable()
                        Text(verbatim: model.range(next)).monospacedDigit()
                    }
                    .font(.caption.weight(.semibold))
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
