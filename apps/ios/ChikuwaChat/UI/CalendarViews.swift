import SwiftUI

/// What the event form opens on: a new event (its draft) or an event I see.
enum CalendarFormTarget: Identifiable {
    case new(EventDraft)
    case event(CalendarEventOut)

    var id: String {
        switch self {
        case .new: "new"
        case .event(let event): event.id
        }
    }
}

/// M52 (CALENDAR.md §7, the phone column): 「カレンダー」 from the home's tile. 一覧: the days with events from today, 60 days
/// ahead; 月: the month's days with a dot per event (in its calendar's colour), the chosen day's events below. 「すべて /
/// 自分 / #チャンネル」 filters. Weeks start on Sunday, as the web's. M56 (TASKS.md §6): the tasks due in the range show as
/// all-day rows 「☐ 題名」 (done 「☑」, struck through), and a dot in the month; a tap opens the task. M69 (CALENDAR.md
/// §10.9): ⋯ → 「カレンダーを購読 (iCal)」 opens the private feed URLs (CalendarFeedsView).
struct CalendarView: View {
    static let selectionId = "calendar"
    static let windowKey = "view"
    /// M56: the tasks due in the range shown (TaskHub's calendar window).
    static let taskWindowKey = "calendar"
    static let modeKey = "chikuwa.calendar.mode"

    enum Mode: String, CaseIterable {
        case list, month
        var title: String { self == .list ? "一覧" : "月" }
    }

    @Bindable var controller: AppController
    /// Tests pass their own hub and day.
    var hub: CalendarHub? = nil
    var tasks: TaskHub? = nil
    var today: DayKey? = nil
    @AppStorage(CalendarView.modeKey) private var modeRaw = Mode.list.rawValue
    @State private var filter: CalendarFilter = .all
    /// The month shown (its first day); nil: this month.
    @State private var month: DayKey?
    /// The day whose events the month lists; nil: today.
    @State private var selectedDay: DayKey?
    @State private var form: CalendarFormTarget?
    @State private var taskForm: TaskFormTarget?
    @State private var feeds = false

    private var calendarHub: CalendarHub? { hub ?? controller.calendarHub }
    private var taskHub: TaskHub? { tasks ?? controller.taskHub }
    private var now: DayKey { today ?? CalendarDates.today() }
    private var mode: Mode { Mode(rawValue: modeRaw) ?? .list }
    private var shownMonth: DayKey { month ?? CalendarDates.addMonths(now, 0) }
    private var chosenDay: DayKey { selectedDay ?? (CalendarDates.sameMonth(now, shownMonth) ? now : shownMonth) }

    private var range: (start: DayKey, end: DayKey) {
        mode == .list ? (now, CalendarDates.addDays(now, CalendarDates.listDays)) : CalendarDates.monthRange(shownMonth)
    }

    var body: some View {
        let hub = calendarHub
        let window = hub?.window(Self.windowKey)
        let events = (window?.events ?? []).filter(filter.matches)
        let dueTasks = TaskRules.filter(taskHub?.dueWindow(Self.taskWindowKey)?.tasks ?? [], filter, me: controller.store.me?.id)
        VStack(spacing: 0) {
            controls
            Divider()
            if hub == nil {
                CalendarNote(title: "接続すると表示します", systemImage: "calendar")
            } else if window?.state == .unsupported {
                CalendarNote(title: "このサーバはカレンダーに対応していません", systemImage: "calendar", detail: "サーバの更新後に使えるようになります。")
            } else if mode == .month {
                monthView(events, tasks: dueTasks, window: window)
            } else {
                listView(events, tasks: dueTasks, window: window)
            }
        }
        .navigationTitle("カレンダー")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button { feeds = true } label: { Label("カレンダーを購読 (iCal)", systemImage: "dot.radiowaves.up.forward") }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .accessibilityLabel("その他")
                .disabled(hub == nil)
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button { form = .new(newDraft(on: mode == .month ? chosenDay : now)) } label: { Image(systemName: "plus") }
                    .accessibilityLabel("予定を追加")
                    .disabled(hub == nil)
            }
        }
        .task(id: "\(range.start) \(range.end)") {
            await calendarHub?.open(Self.windowKey, from: CalendarDates.parseDay(range.start), to: CalendarDates.parseDay(range.end))
        }
        .task(id: "tasks \(range.start) \(range.end)") {
            await taskHub?.openDue(Self.taskWindowKey, from: range.start, to: range.end) // M56 (dates, the end excluded)
        }
        .onDisappear {
            if form == nil && taskForm == nil && !feeds {
                calendarHub?.close(Self.windowKey)
                taskHub?.closeDue(Self.taskWindowKey)
            }
        }
        .onChange(of: controller.calendarOpen, initial: true) { _, open in
            // A notification of my own calendar's event (M52): shown here.
            guard let open, open.channelId == nil, let hub = calendarHub else { return }
            controller.calendarOpen = nil
            Task { await CalendarNote.show(open.eventId, hub: hub, controller: controller) { form = .event($0) } }
        }
        .fullScreenCover(item: $form) { target in
            CalendarEventForm(controller: controller, hub: calendarHub, target: target)
        }
        .fullScreenCover(item: $taskForm) { target in
            TaskForm(controller: controller, hub: taskHub, target: target)
        }
        .sheet(isPresented: $feeds) {
            CalendarFeedsView(model: CalendarFeedsModel(api: controller.api))
        }
    }

    /// M56: a task row's tap: the task as it is now.
    private func openTask(_ task: TaskOut) {
        taskForm = .task(taskHub?.find(task.id) ?? task)
    }

    /// A new event on the day, in the calendar filtered to (if I may add to it).
    private func newDraft(on day: DayKey) -> EventDraft {
        var channelId: String?
        if case .channel(let id) = filter, controller.writableCalendars.contains(where: { $0.id == id }) { channelId = id }
        return EventDraft.new(on: day, channelId: channelId)
    }

    private var filterTitle: String {
        switch filter {
        case .all: "すべて"
        case .mine: "自分"
        case .channel(let id): "#" + (controller.store.channel(id)?.channel.name ?? "")
        }
    }

    private var controls: some View {
        HStack(spacing: 10) {
            Picker("表示", selection: $modeRaw) {
                ForEach(Mode.allCases, id: \.rawValue) { Text($0.title).tag($0.rawValue) }
            }
            .pickerStyle(.segmented)
            .frame(maxWidth: 160)
            Spacer(minLength: 0)
            Menu {
                Picker("絞り込み", selection: $filter) {
                    Text("すべて").tag(CalendarFilter.all)
                    Text("自分").tag(CalendarFilter.mine)
                    ForEach(controller.readableCalendars) { channel in
                        Text("#" + (channel.channel.name ?? "")).tag(CalendarFilter.channel(channel.id))
                    }
                }
            } label: {
                Label(filterTitle, systemImage: "line.3.horizontal.decrease.circle")
                    .font(.subheadline)
                    .lineLimit(1)
            }
            .accessibilityLabel("絞り込み")
            .accessibilityValue(filterTitle)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
    }

    // MARK: 一覧

    @ViewBuilder
    private func listView(_ events: [CalendarEventOut], tasks: [TaskOut], window: CalendarWindow?) -> some View {
        let days = CalendarDates.agenda(events, from: range.start, to: range.end)
        if days.isEmpty && tasks.isEmpty {
            if window == nil || window?.state == .loading {
                ProgressView("読み込み中…").frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if window?.state == .failed {
                CalendarLoadFailed { await calendarHub?.reload(Self.windowKey) }
            } else {
                CalendarNote(title: "これから \(CalendarDates.listDays) 日の予定はありません", systemImage: "calendar",
                             detail: "右上の＋で予定を追加できます。")
            }
        } else {
            CalendarAgendaList(days: days, today: now, showCalendar: true, failed: window?.state == .failed, tasks: tasks,
                               onOpenTask: openTask) { form = .event($0) }
                .refreshable { await calendarHub?.reload(Self.windowKey) }
        }
    }

    // MARK: 月

    private func monthView(_ events: [CalendarEventOut], tasks: [TaskOut], window: CalendarWindow?) -> some View {
        let dayEvents = CalendarDates.eventsOn(events, chosenDay)
        let dayTasks = TaskRules.tasksForDay(tasks, chosenDay)
        return ScrollView {
            VStack(spacing: 0) {
                CalendarMonthGrid(month: shownMonth, today: now, selected: chosenDay, events: events, tasks: tasks) { day in
                    selectedDay = day
                    if !CalendarDates.sameMonth(day, shownMonth) { month = CalendarDates.addMonths(day, 0) }
                } onMove: { step in
                    month = CalendarDates.addMonths(shownMonth, step)
                    selectedDay = nil
                } onToday: {
                    month = nil
                    selectedDay = nil
                }
                Divider().padding(.top, 6)
                HStack {
                    Text(CalendarDates.dayLabel(chosenDay)).font(.subheadline.weight(.semibold))
                    if chosenDay == now { Text("今日").font(.caption.weight(.semibold)).foregroundStyle(.tint) }
                    Spacer()
                    Button { form = .new(newDraft(on: chosenDay)) } label: { Label("追加", systemImage: "plus").font(.subheadline) }
                        .accessibilityLabel("\(CalendarDates.dayLabel(chosenDay)) に予定を追加")
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                if window?.state == .failed {
                    CalendarLoadFailed { await calendarHub?.reload(Self.windowKey) }.padding(.vertical, 12)
                } else if dayEvents.isEmpty && dayTasks.isEmpty {
                    Text(window?.state == .loading ? "読み込み中…" : "予定はありません")
                        .font(.subheadline).foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity).padding(.vertical, 24)
                } else {
                    VStack(spacing: 0) {
                        ForEach(dayTasks) { task in
                            Button { openTask(task) } label: {
                                CalendarTaskRow(task: task, showCalendar: true).padding(.horizontal, 16).padding(.vertical, 9)
                            }
                            .buttonStyle(.plain)
                            Divider().padding(.leading, 16)
                        }
                        ForEach(dayEvents) { event in
                            Button { form = .event(event) } label: {
                                CalendarEventRow(event: event, day: chosenDay, showCalendar: true)
                                    .padding(.horizontal, 16).padding(.vertical, 9)
                            }
                            .buttonStyle(.plain)
                            Divider().padding(.leading, 16)
                        }
                    }
                }
            }
        }
        .refreshable { await calendarHub?.reload(Self.windowKey) }
    }
}

/// The month's grid (Sunday first): the day numbers (today filled, the chosen day ringed, Sunday red, Saturday blue),
/// up to three dots per day in the events' colours.
struct CalendarMonthGrid: View {
    let month: DayKey
    let today: DayKey
    let selected: DayKey
    let events: [CalendarEventOut]
    /// M56: the tasks due in the month (a dot each, after the events').
    var tasks: [TaskOut] = []
    let onSelect: (DayKey) -> Void
    let onMove: (Int) -> Void
    let onToday: () -> Void

    static let dots = 3

    var body: some View {
        VStack(spacing: 4) {
            HStack(spacing: 4) {
                Button { onMove(-1) } label: { Image(systemName: "chevron.left").frame(width: 36, height: 36) }
                    .accessibilityLabel("前の月")
                Text(CalendarDates.monthLabel(month)).font(.headline).frame(maxWidth: .infinity)
                Button { onMove(1) } label: { Image(systemName: "chevron.right").frame(width: 36, height: 36) }
                    .accessibilityLabel("次の月")
            }
            .overlay(alignment: .trailing) {
                if !CalendarDates.sameMonth(month, today) {
                    Button("今日", action: onToday).font(.subheadline).padding(.trailing, 44)
                }
            }
            .padding(.horizontal, 8)
            HStack(spacing: 0) {
                ForEach(0..<7, id: \.self) { index in
                    Text(CalendarDates.weekdays[index])
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(Self.weekdayColor(index) ?? .secondary)
                        .frame(maxWidth: .infinity)
                }
            }
            ForEach(CalendarDates.monthGrid(month), id: \.first) { week in
                HStack(spacing: 0) {
                    ForEach(Array(week.enumerated()), id: \.element) { index, day in cell(day, weekday: index) }
                }
            }
        }
        .padding(.top, 6)
    }

    static func weekdayColor(_ index: Int) -> Color? {
        index == 0 ? .red : index == 6 ? .blue : nil
    }

    private func cell(_ day: DayKey, weekday: Int) -> some View {
        let list = CalendarDates.eventsOn(events, day)
        let due = TaskRules.tasksForDay(tasks, day)
        let dots = (list.map(\.channelId) + due.map(\.channelId)).prefix(Self.dots)
        let outside = !CalendarDates.sameMonth(day, month)
        let isToday = day == today
        let isSelected = day == selected
        return Button { onSelect(day) } label: {
            VStack(spacing: 3) {
                Text("\(CalendarDates.dayOfMonth(day))")
                    .font(.callout.weight(isToday ? .bold : .regular))
                    .monospacedDigit()
                    .foregroundStyle(isToday ? Color.white : (Self.weekdayColor(weekday) ?? .primary))
                    .frame(width: 32, height: 32)
                    .background {
                        if isToday { Circle().fill(Color.accentColor) }
                        else if isSelected { Circle().fill(Color.accentColor.opacity(0.18)) }
                    }
                HStack(spacing: 3) {
                    ForEach(Array(dots.enumerated()), id: \.offset) { _, channelId in
                        Circle().fill(CalendarDates.color(channelId)).frame(width: 6, height: 6)
                    }
                }
                .frame(height: 6)
            }
            .opacity(outside ? 0.4 : 1)
            .frame(maxWidth: .infinity, minHeight: 50)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(CalendarDates.dayLabel(day) + (list.isEmpty ? "" : "、予定 \(list.count) 件") + (due.isEmpty ? "" : "、タスク \(due.count) 件"))
        .accessibilityAddTraits(isSelected ? [.isSelected] : [])
    }
}

/// Day by day, the days with events (or, M56, tasks due) only (「今日」「明日」 marked); a day's tasks come first, as
/// all-day rows.
struct CalendarAgendaList: View {
    let days: [(day: DayKey, events: [CalendarEventOut])]
    let today: DayKey
    let showCalendar: Bool
    var failed = false
    /// M56: the tasks due in the range.
    var tasks: [TaskOut] = []
    var onOpenTask: (TaskOut) -> Void = { _ in }
    let onOpen: (CalendarEventOut) -> Void

    private var entries: [(day: DayKey, events: [CalendarEventOut], tasks: [TaskOut])] {
        let byDay = Dictionary(days.map { ($0.day, $0.events) }, uniquingKeysWith: { first, _ in first })
        let allDays = Set(days.map(\.day)).union(tasks.compactMap(\.dueOn)).sorted()
        return allDays.map { day in (day, byDay[day] ?? [], TaskRules.tasksForDay(tasks, day)) }
    }

    var body: some View {
        List {
            if failed {
                Text("予定を読み込めませんでした。下に引いて読み直せます。").font(.footnote).foregroundStyle(.secondary)
            }
            ForEach(entries, id: \.day) { entry in
                Section {
                    ForEach(entry.tasks) { task in
                        Button { onOpenTask(task) } label: { CalendarTaskRow(task: task, showCalendar: showCalendar) }
                            .buttonStyle(.plain)
                    }
                    ForEach(entry.events) { event in
                        Button { onOpen(event) } label: { CalendarEventRow(event: event, day: entry.day, showCalendar: showCalendar) }
                            .buttonStyle(.plain)
                    }
                } header: {
                    HStack(spacing: 6) {
                        Text(CalendarDates.dayLabel(entry.day))
                        if entry.day == today { Text("今日").foregroundStyle(.tint) }
                        if entry.day == CalendarDates.addDays(today, 1) { Text("明日") }
                    }
                    .font(.footnote.weight(.semibold))
                }
            }
        }
        .listStyle(.plain)
    }
}

/// One event on a day: its time there, its calendar's colour, the title, the calendar and the place.
struct CalendarEventRow: View {
    let event: CalendarEventOut
    let day: DayKey
    let showCalendar: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Text(CalendarDates.timeOnDay(event, day))
                .font(.caption)
                .monospacedDigit()
                .foregroundStyle(.secondary)
                .frame(width: 86, alignment: .leading)
                .padding(.top, 2)
            RoundedRectangle(cornerRadius: 2).fill(CalendarDates.color(event.channelId)).frame(width: 4)
            VStack(alignment: .leading, spacing: 2) {
                Text(event.title).font(.subheadline.weight(.medium)).lineLimit(2)
                let calendar = showCalendar ? (event.channelName.map { "#" + $0 } ?? "自分") : nil
                if calendar != nil || event.location != nil || event.recurring {
                    HStack(spacing: 8) {
                        if let calendar { Text(calendar).lineLimit(1) }
                        if event.recurring {
                            // M69: 🔁 and the rule in words.
                            Label(CalendarRecurrence.describe(event.rrule, start: CalendarDates.eventDays(event).first), systemImage: "repeat")
                                .labelStyle(CompactLabelStyle()).lineLimit(1)
                        }
                        if let location = event.location {
                            Label(location, systemImage: "mappin.and.ellipse").labelStyle(CompactLabelStyle()).lineLimit(1)
                        }
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 0)
            if event.alarm?.status == "pending" {
                Image(systemName: "bell").font(.caption).foregroundStyle(.secondary).accessibilityLabel("通知あり")
            }
        }
        .fixedSize(horizontal: false, vertical: true)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

/// A label with its icon close to its text.
private struct CompactLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 2) {
            configuration.icon
            configuration.title
        }
    }
}

/// M52: a channel's 「予定」 tab (public and private channels; DMs have no shared calendar): its events for the next 60
/// days and 「予定を追加」 for those who may post.
struct ChannelEventsPane: View {
    @Bindable var controller: AppController
    let channel: ChannelState
    var hub: CalendarHub? = nil
    var today: DayKey? = nil
    @State private var form: CalendarFormTarget?

    private var calendarHub: CalendarHub? { hub ?? controller.calendarHub }
    private var now: DayKey { today ?? CalendarDates.today() }
    private var key: String { "channel:\(channel.id)" }

    var body: some View {
        let window = calendarHub?.window(key)
        let end = CalendarDates.addDays(now, CalendarDates.listDays)
        let canAdd = controller.writableCalendars.contains { $0.id == channel.id }
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Text("予定").font(.subheadline.weight(.semibold))
                Text("これから \(CalendarDates.listDays) 日").font(.caption).foregroundStyle(.secondary)
                Spacer()
                if canAdd {
                    Button { form = .new(EventDraft.new(on: now, channelId: channel.id)) } label: {
                        Label("予定を追加", systemImage: "plus").font(.subheadline)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                    .disabled(calendarHub == nil)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
            Divider()
            let days = CalendarDates.agenda(window?.events ?? [], from: now, to: end)
            if calendarHub == nil {
                CalendarNote(title: "接続すると表示します", systemImage: "calendar")
            } else if window?.state == .unsupported {
                CalendarNote(title: "このサーバはカレンダーに対応していません", systemImage: "calendar", detail: "サーバの更新後に使えるようになります。")
            } else if days.isEmpty {
                if window == nil || window?.state == .loading {
                    ProgressView("読み込み中…").frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if window?.state == .failed {
                    CalendarLoadFailed { await calendarHub?.reload(key) }
                } else {
                    CalendarNote(title: "これからの予定はありません", systemImage: "calendar",
                                 detail: canAdd ? "ゼミや締切など、このチャンネルのメンバーと共有する予定を追加できます。" : nil)
                }
            } else {
                CalendarAgendaList(days: days, today: now, showCalendar: false, failed: window?.state == .failed) { form = .event($0) }
                    .refreshable { await calendarHub?.reload(key) }
            }
        }
        .task(id: "\(key) \(now)") {
            await calendarHub?.open(key, from: CalendarDates.parseDay(now), to: CalendarDates.parseDay(end), channelId: channel.id)
        }
        .onDisappear { if form == nil { calendarHub?.close(key) } }
        .onChange(of: controller.calendarOpen, initial: true) { _, open in
            // A notification of this channel's event (M52): shown over its tab.
            guard let open, open.channelId == channel.id, let hub = calendarHub else { return }
            controller.calendarOpen = nil
            Task { await CalendarNote.show(open.eventId, hub: hub, controller: controller) { form = .event($0) } }
        }
        .fullScreenCover(item: $form) { target in
            CalendarEventForm(controller: controller, hub: calendarHub, target: target)
        }
    }
}

/// A line in the middle of an empty calendar.
struct CalendarNote: View {
    let title: String
    let systemImage: String
    var detail: String? = nil

    var body: some View {
        ContentUnavailableView {
            Label(title, systemImage: systemImage)
        } description: {
            if let detail { Text(detail) }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    /// A notification's event: as held, else read; a failure (gone, no longer mine to see) says so.
    @MainActor
    static func show(_ eventId: String, hub: CalendarHub, controller: AppController, open: (CalendarEventOut) -> Void) async {
        do {
            open(try await hub.fetch(eventId))
        } catch {
            controller.error = controller.describe(error)
        }
    }
}

/// The range could not be read: 再読み込み.
struct CalendarLoadFailed: View {
    let retry: () async -> Void

    var body: some View {
        ContentUnavailableView {
            Label("予定を読み込めませんでした", systemImage: "exclamationmark.triangle")
        } description: {
            Text("接続を確かめてから、もう一度お試しください。")
        } actions: {
            Button("再読み込み") { Task { await retry() } }.buttonStyle(.bordered)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
