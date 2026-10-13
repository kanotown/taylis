import Foundation

// The 今日の予定・締切 widget: today's events of my calendar and my channels' (CALENDAR.md), and my open tasks due today
// or overdue (TASKS.md: 「自分のタスク」, personal or assigned to me). The extension reads them itself with the shared
// tokens (GET /calendar/events for today and tomorrow, GET /tasks/mine), so the widget rolls over at midnight and stays
// current without the app; the app only says when something changed (AppController+TodayWidget.swift: the snapshot is
// marked stale and the widget reloaded). The rules are the app's (CalendarDates, TaskRules), restated here because the
// extension does not compile those files; TodayWidgetTests checks they agree.

typealias WidgetDay = String

struct TodayWidgetEvent: Codable, Equatable, Identifiable {
    /// The occurrence's id (a recurring event comes once per occurrence, as GET /calendar/events answers).
    let id: String
    let title: String
    let allDay: Bool
    /// Timed events.
    var startsAt: Date?
    var endsAt: Date?
    /// All-day events: "YYYY-MM-DD", the end included.
    var startDate: WidgetDay?
    var endDate: WidgetDay?
    /// nil: my own calendar.
    var channelId: String?
    var channelName: String?
}

struct TodayWidgetTask: Codable, Equatable, Identifiable {
    let id: String
    let title: String
    /// nil: a personal task.
    var channelId: String?
    var channelName: String?
    var dueOn: WidgetDay?
    /// A due time (M81).
    var dueAt: Date?
}

struct TodayWidgetSnapshot: WidgetAccountSnapshot {
    var serverUrl: String
    var account: String
    var workspaceName: String
    var userId: String
    /// The events overlapping the two days from `from`, and my open tasks due by the second (or earlier).
    var events: [TodayWidgetEvent] = []
    var tasks: [TodayWidgetTask] = []
    /// The first of the two days read; nil: not read yet.
    var from: WidgetDay?
    /// When the app saw a change (or wrote it first): read again at once. nil once read after it.
    var staleSince: Date?
    var updatedAt: Date
    var problem: WidgetProblem?

    /// Read again when older than this (the timeline asks every half hour; the app reloads it on every change it sees).
    static let freshFor: TimeInterval = 15 * 60
}

enum TodayWidgetRules {
    /// Rows: the medium widget's columns, the large widget's sections.
    static let mediumEvents = 4
    static let mediumTasks = 4
    static let largeEvents = 7
    static let largeTasks = 5
    /// The days read: today and tomorrow (the timeline rolls over to tomorrow at midnight without the app).
    static let daysRead = 2
    /// The timeline's re-read.
    static let refreshInterval: TimeInterval = 30 * 60
    static let maxEntries = 48

    // MARK: days (CalendarDates' rules, in a given calendar)

    static func dayKey(_ date: Date, _ calendar: Calendar = .current) -> WidgetDay {
        let p = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", p.year!, p.month!, p.day!)
    }

    static func startOfDay(_ key: WidgetDay, _ calendar: Calendar = .current) -> Date? {
        let parts = key.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        return calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2]))
    }

    static func addDays(_ key: WidgetDay, _ days: Int, _ calendar: Calendar = .current) -> WidgetDay {
        guard let start = startOfDay(key, calendar), let moved = calendar.date(byAdding: .day, value: days, to: start) else { return key }
        return dayKey(moved, calendar)
    }

    /// The next local midnight after `date`.
    static func nextMidnight(after date: Date, _ calendar: Calendar = .current) -> Date {
        let start = calendar.startOfDay(for: date)
        return calendar.date(byAdding: .day, value: 1, to: start) ?? start.addingTimeInterval(86_400)
    }

    /// The first and last local day an event covers (CalendarDates.eventDays).
    static func eventDays(_ event: TodayWidgetEvent, _ calendar: Calendar = .current) -> (first: WidgetDay, last: WidgetDay) {
        if event.allDay { return (event.startDate ?? "", event.endDate ?? event.startDate ?? "") }
        guard let start = event.startsAt else { return ("", "") }
        let end = (event.endsAt ?? start).addingTimeInterval(-0.001)
        return (dayKey(start, calendar), dayKey(end < start ? start : end, calendar))
    }

    static func coversDay(_ event: TodayWidgetEvent, _ day: WidgetDay, _ calendar: Calendar = .current) -> Bool {
        let days = eventDays(event, calendar)
        return days.first <= day && day <= days.last
    }

    /// The events on a day as the app's calendar lists them (CalendarDates.eventsOn): all-day ones and those that began
    /// earlier first, then by start time, then by title.
    static func events(on day: WidgetDay, _ events: [TodayWidgetEvent], _ calendar: Calendar = .current) -> [TodayWidgetEvent] {
        func rank(_ e: TodayWidgetEvent) -> Int { e.allDay || eventDays(e, calendar).first < day ? 0 : 1 }
        func key(_ e: TodayWidgetEvent) -> String {
            if e.allDay { return (e.startDate ?? "") + "T" }
            guard let start = e.startsAt else { return "" }
            let p = calendar.dateComponents([.hour, .minute], from: start)
            return dayKey(start, calendar) + "T" + String(format: "%02d:%02d", p.hour!, p.minute!)
        }
        let japanese = Locale(identifier: "ja")
        return events.filter { coversDay($0, day, calendar) }.sorted { a, b in
            if rank(a) != rank(b) { return rank(a) < rank(b) }
            let ka = key(a), kb = key(b)
            if ka != kb { return ka < kb }
            let byTitle = a.title.compare(b.title, locale: japanese)
            return byTitle == .orderedSame ? a.id < b.id : byTitle == .orderedAscending
        }
    }

    /// Over at `now`: a timed event whose end has passed (an all-day one lasts the day).
    static func isOver(_ event: TodayWidgetEvent, now: Date) -> Bool {
        guard !event.allDay, let end = event.endsAt ?? event.startsAt else { return false }
        return end <= now
    }

    /// The event the small widget shows: the first of today's not over yet that starts later or is under way (timed),
    /// else today's first all-day one.
    static func nextEvent(_ events: [TodayWidgetEvent], now: Date, _ calendar: Calendar = .current) -> TodayWidgetEvent? {
        let today = self.events(on: dayKey(now, calendar), events, calendar)
        return today.first { !$0.allDay && !isOver($0, now: now) } ?? today.first { $0.allDay }
    }

    /// At most `limit` of a day's events: those already over leave first.
    static func visible(_ events: [TodayWidgetEvent], now: Date, limit: Int) -> [TodayWidgetEvent] {
        guard events.count > limit else { return events }
        var list = events
        while list.count > limit, let index = list.firstIndex(where: { isOver($0, now: now) }) { list.remove(at: index) }
        return Array(list.prefix(limit))
    }

    // MARK: tasks (TaskRules' rules)

    /// The local day a task is due on: a due time's local date (M81), else `due_on`.
    static func dueDay(_ task: TodayWidgetTask, _ calendar: Calendar = .current) -> WidgetDay? {
        if let at = task.dueAt { return dayKey(at, calendar) }
        return task.dueOn
    }

    /// Past due: a due time once it has passed, a date once its day is over (TaskRules.overdue of an open task).
    static func isOverdue(_ task: TodayWidgetTask, today: WidgetDay, now: Date) -> Bool {
        guard let dueOn = task.dueOn else { return false }
        if let at = task.dueAt { return at < now }
        return dueOn < today
    }

    /// The tasks the widget lists on `now`'s day: overdue ones (oldest first), then today's (without a time first, then
    /// by time), then by title.
    static func tasks(_ tasks: [TodayWidgetTask], now: Date, _ calendar: Calendar = .current) -> [TodayWidgetTask] {
        let today = dayKey(now, calendar)
        let listed = tasks.filter { task in
            guard let day = dueDay(task, calendar) else { return false }
            return day <= today || isOverdue(task, today: today, now: now)
        }
        func time(_ t: TodayWidgetTask) -> Double { t.dueAt?.timeIntervalSince1970 ?? -1 }
        return listed.sorted { a, b in
            let oa = isOverdue(a, today: today, now: now), ob = isOverdue(b, today: today, now: now)
            if oa != ob { return oa }
            let da = dueDay(a, calendar) ?? "", db = dueDay(b, calendar) ?? ""
            if da != db { return da < db }
            if time(a) != time(b) { return time(a) < time(b) }
            let order = a.title.localizedStandardCompare(b.title)
            return order == .orderedSame ? a.id < b.id : order == .orderedAscending
        }
    }

    static func overdueCount(_ tasks: [TodayWidgetTask], now: Date, _ calendar: Calendar = .current) -> Int {
        let today = dayKey(now, calendar)
        return self.tasks(tasks, now: now, calendar).filter { isOverdue($0, today: today, now: now) }.count
    }

    // MARK: the snapshot

    /// Read again: the app said so, the last try failed, it is old, or it does not hold today and tomorrow.
    static func needsRefresh(_ snapshot: TodayWidgetSnapshot, now: Date = Date(), _ calendar: Calendar = .current) -> Bool {
        snapshot.staleSince != nil || snapshot.problem != nil || snapshot.from != dayKey(now, calendar)
            || now.timeIntervalSince(snapshot.updatedAt) >= TodayWidgetSnapshot.freshFor
    }

    /// The moments the face changes without a new read: every start and end of an event and every due time between now
    /// and the end of the days read (or of tomorrow), and each midnight (the next day's list).
    static func entryDates(_ snapshot: TodayWidgetSnapshot?, now: Date, _ calendar: Calendar = .current) -> [Date] {
        let today = dayKey(now, calendar)
        let lastDay = snapshot?.from.map { addDays($0, daysRead, calendar) } ?? addDays(today, 1, calendar)
        let horizon = max(startOfDay(lastDay, calendar) ?? now, nextMidnight(after: now, calendar))
        var dates: Set<Date> = []
        var midnight = nextMidnight(after: now, calendar)
        while midnight <= horizon {
            dates.insert(midnight)
            midnight = nextMidnight(after: midnight, calendar)
        }
        for event in snapshot?.events ?? [] where !event.allDay {
            for date in [event.startsAt, event.endsAt].compactMap({ $0 }) where date > now && date < horizon { dates.insert(date) }
        }
        for task in snapshot?.tasks ?? [] {
            if let at = task.dueAt, at > now, at < horizon { dates.insert(at) }
        }
        return [now] + dates.sorted().prefix(maxEntries - 1)
    }

    // MARK: the server's answers

    struct ServerEvent: Decodable {
        let id: String
        let title: String
        let allDay: Bool
        let startsAt: String?
        let endsAt: String?
        let startDate: String?
        let endDate: String?
        let channelId: String?
        let channelName: String?
    }

    struct ServerTask: Decodable {
        let id: String
        let title: String
        let status: String
        let channelId: String?
        let channelName: String?
        let dueOn: String?
        let dueAt: String?
        var assigneeIds: [String] = []

        private enum CodingKeys: String, CodingKey { case id, title, status, channelId, channelName, dueOn, dueAt, assigneeIds }

        init(id: String, title: String, status: String, channelId: String?, channelName: String?, dueOn: String?, dueAt: String?,
             assigneeIds: [String] = []) {
            self.id = id
            self.title = title
            self.status = status
            self.channelId = channelId
            self.channelName = channelName
            self.dueOn = dueOn
            self.dueAt = dueAt
            self.assigneeIds = assigneeIds
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = try c.decode(String.self, forKey: .id)
            title = try c.decode(String.self, forKey: .title)
            status = try c.decode(String.self, forKey: .status)
            channelId = try c.decodeIfPresent(String.self, forKey: .channelId)
            channelName = try c.decodeIfPresent(String.self, forKey: .channelName)
            dueOn = try c.decodeIfPresent(String.self, forKey: .dueOn)
            dueAt = try c.decodeIfPresent(String.self, forKey: .dueAt)
            assigneeIds = try c.decodeIfPresent([String].self, forKey: .assigneeIds) ?? []
        }
    }

    static func date(_ iso: String?) -> Date? {
        guard let iso else { return nil }
        return (try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(iso)) ?? (try? Date.ISO8601FormatStyle().parse(iso))
    }

    static func event(_ e: ServerEvent) -> TodayWidgetEvent {
        TodayWidgetEvent(id: e.id, title: e.title, allDay: e.allDay, startsAt: date(e.startsAt), endsAt: date(e.endsAt), startDate: e.startDate,
                         endDate: e.endDate, channelId: e.channelId, channelName: e.channelName)
    }

    /// My open tasks (personal, or assigned to me: TaskRules.isMine) due by `lastDay` or earlier.
    static func tasks(_ list: [ServerTask], me: String, lastDay: WidgetDay, _ calendar: Calendar = .current) -> [TodayWidgetTask] {
        list.compactMap { t in
            guard t.status != "done", t.channelId == nil || t.assigneeIds.contains(me), t.dueOn != nil else { return nil }
            let task = TodayWidgetTask(id: t.id, title: t.title, channelId: t.channelId, channelName: t.channelName, dueOn: t.dueOn,
                                       dueAt: date(t.dueAt))
            guard let day = dueDay(task, calendar), day <= lastDay else { return nil }
            return task
        }
    }

    /// The server's answers replace what the snapshot held.
    static func applying(events: [ServerEvent], tasks: [ServerTask], from: WidgetDay, to snapshot: TodayWidgetSnapshot,
                         now: Date = Date(), _ calendar: Calendar = .current) -> TodayWidgetSnapshot {
        var next = snapshot
        next.events = events.map(event)
        next.tasks = self.tasks(tasks, me: snapshot.userId, lastDay: addDays(from, daysRead - 1, calendar), calendar)
        next.from = from
        next.staleSince = nil
        next.problem = nil
        next.updatedAt = now
        return next
    }

    static func failed(_ snapshot: TodayWidgetSnapshot, _ failure: ShareFailure) -> TodayWidgetSnapshot {
        var next = snapshot
        next.problem = WidgetProblem(failure)
        return next
    }

    /// The link a row opens.
    static func link(_ event: TodayWidgetEvent, server: String) -> WidgetLink {
        .event(id: event.id, channelId: event.channelId, server: server)
    }

    /// (A review request's DM has no board: the app opens it in 「自分のタスク」, as its notification.)
    static func link(_ task: TodayWidgetTask, server: String) -> WidgetLink {
        .task(id: task.id, channelId: task.channelId, server: server)
    }

    /// A calendar's colour (CalendarDates.colorHex: the same palette and hash, my own in slate).
    static let palette: [UInt32] = [0x2563EB, 0x16A34A, 0xDC2626, 0x9333EA, 0x0891B2, 0xDB2777, 0xEA580C, 0xA16207, 0x4F46E5]
    static let ownColor: UInt32 = 0x64748B

    static func color(_ channelId: String?) -> UInt32 {
        guard let channelId else { return ownColor }
        var hash: UInt32 = 0x811c9dc5
        for unit in channelId.utf16 {
            hash ^= UInt32(unit)
            hash = hash &* 0x01000193
        }
        return palette[Int(hash % UInt32(palette.count))]
    }
}

enum TodayWidgetStore {
    static let widgetKind = "jp.chikuwachat.ios.today"
    static let file = WidgetSnapshotFile<TodayWidgetSnapshot>(name: "today")
}

extension ShareApi {
    /// GET /calendar/events over [from, to) (the device's local midnights, with their offsets).
    func calendarEvents(from: Date, to: Date) async throws -> [TodayWidgetRules.ServerEvent] {
        let format = Date.ISO8601FormatStyle(timeZone: .current)
        return try await getJSON("/api/v1/calendar/events", query: [
            URLQueryItem(name: "from", value: from.formatted(format)), URLQueryItem(name: "to", value: to.formatted(format)),
        ])
    }

    /// GET /tasks/mine: my own and those assigned to me (the 50 newest completed ones too).
    func myTasks() async throws -> [TodayWidgetRules.ServerTask] { try await getJSON("/api/v1/tasks/mine") }
}

enum TodayWidgetActions {
    /// Today's and tomorrow's events and my tasks read again (the widget's timeline). A server without a calendar
    /// (before M51: 404) has no events; one without tasks, none.
    @discardableResult
    static func refresh(account: String, now: Date = Date(), calendar: Calendar = .current,
                        file: WidgetSnapshotFile<TodayWidgetSnapshot> = TodayWidgetStore.file,
                        makeApi: (String, String) -> ShareApi? = WidgetApis.make) async -> TodayWidgetSnapshot? {
        guard let snapshot = file.snapshot(account: account), let api = makeApi(snapshot.serverUrl, snapshot.account) else { return nil }
        let started = Date()
        let from = TodayWidgetRules.dayKey(now, calendar)
        let start = calendar.startOfDay(for: now)
        let end = calendar.date(byAdding: .day, value: TodayWidgetRules.daysRead, to: start) ?? start.addingTimeInterval(2 * 86_400)
        func missing(_ failure: ShareFailure) -> Bool {
            if case .refused(404, _) = failure { return true }
            return false
        }
        var next: TodayWidgetSnapshot
        do {
            async let eventsCall = api.calendarEvents(from: start, to: end)
            async let tasksCall = api.myTasks()
            let events: [TodayWidgetRules.ServerEvent]
            do { events = try await eventsCall } catch let failure as ShareFailure where missing(failure) { events = [] }
            let tasks: [TodayWidgetRules.ServerTask]
            do { tasks = try await tasksCall } catch let failure as ShareFailure where missing(failure) { tasks = [] }
            next = TodayWidgetRules.applying(events: events, tasks: tasks, from: from, to: snapshot, now: now, calendar)
        } catch let failure as ShareFailure {
            next = TodayWidgetRules.failed(snapshot, failure)
        } catch {
            next = TodayWidgetRules.failed(snapshot, .temporary("unknown"))
        }
        // The app marked it stale meanwhile (a change the answers may predate): its mark stays, the next timeline reads again.
        if let mark = file.snapshot(account: account)?.staleSince, mark > started { next.staleSince = mark }
        file.save(next)
        return next
    }
}
