import Foundation
import Observation

/// M52: the calendar calls the hub makes (ApiClient and the test fakes).
@MainActor
protocol CalendarApi: AnyObject {
    func calendarEvents(from: Date, to: Date, channelId: String?) async throws -> [CalendarEventOut]
    func calendarUpcoming(channelId: String?, days: Int, tz: String) async throws -> [CalendarEventOut]
    func calendarEvent(id: String) async throws -> CalendarEventOut
    func createCalendarEvent(_ body: CalendarEventCreate) async throws -> CalendarEventOut
    func updateCalendarEvent(id: String, _ patch: CalendarEventPatch) async throws -> CalendarEventOut
    func deleteCalendarEvent(id: String) async throws
    func setCalendarAlarm(id: String, minutesBefore: Int, tz: String) async throws -> CalendarEventOut
    func clearCalendarAlarm(id: String) async throws
}

/// A screen's range of the calendar: the calendar's month or list, a channel's 「予定」 tab.
struct CalendarWindow: Equatable {
    enum State: Equatable {
        case loading, ready, failed
        /// The server has no calendar (a server from before M51 says 404 not_found).
        case unsupported
    }

    var from: Date
    var to: Date
    /// Only this channel's calendar (a channel's tab); nil: mine and all my channels'.
    var channelId: String?
    var state: State
    /// In order (CalendarDates.inOrder).
    var events: [CalendarEventOut]
}

/// M52: the calendar on this device (CALENDAR.md §5), as the web's CalendarHub (apps/desktop/src/sync/calendar.ts).
/// Nothing is kept for long: each screen that shows events opens a window on a range, read from the server, and the
/// calendar.* events update the windows they overlap (the rest are dropped: the next read has them). A channel's tab
/// count comes from GET /calendar/upcoming, read again when one of its events changes. After reconnecting every window
/// and count is read again, which fills whatever events were missed.
@MainActor
@Observable
final class CalendarHub {
    private(set) var windows: [String: CalendarWindow] = [:]
    private(set) var upcoming: [String: [CalendarEventOut]] = [:]
    /// A read in flight per window: an older answer never replaces a newer one.
    @ObservationIgnored private var reads: [String: Int] = [:]
    @ObservationIgnored private let api: CalendarApi?
    @ObservationIgnored private let me: () -> String?
    @ObservationIgnored private let tz: () -> String
    /// One of my alarms fired (said in the app while it is open; the push covers the background).
    @ObservationIgnored var onAlarm: ((CalendarEventOut) -> Void)?

    init(api: CalendarApi?, me: @escaping () -> String?, tz: @escaping () -> String = { CalendarDates.zoneId }) {
        self.api = api
        self.me = me
        self.tz = tz
    }

    var available: Bool { api != nil }

    func window(_ key: String) -> CalendarWindow? { windows[key] }

    /// The channel's events today and tomorrow not over yet (nil: not read).
    func upcomingOf(_ channelId: String) -> [CalendarEventOut]? { upcoming[channelId] }

    /// A screen shows [from, to): read it (again when the range changes; a window already read stays as it is).
    func open(_ key: String, from: Date, to: Date, channelId: String? = nil) async {
        let current = windows[key]
        let same = current.map { $0.from == from && $0.to == to && $0.channelId == channelId } ?? false
        if same, current?.state == .ready { return }
        windows[key] = CalendarWindow(from: from, to: to, channelId: channelId, state: .loading, events: same ? current?.events ?? [] : [])
        await read(key)
    }

    /// Read a window again (再読み込み).
    func reload(_ key: String) async {
        guard windows[key] != nil else { return }
        windows[key]?.state = .loading
        await read(key)
    }

    func close(_ key: String) {
        windows[key] = nil
        reads[key] = nil
    }

    private func read(_ key: String) async {
        guard let api, let window = windows[key] else { return }
        let ticket = (reads[key] ?? 0) + 1
        reads[key] = ticket
        do {
            let events = try await api.calendarEvents(from: window.from, to: window.to, channelId: window.channelId)
            guard reads[key] == ticket, var now = windows[key], now.from == window.from, now.to == window.to else { return }
            now.state = .ready
            now.events = events.sorted(by: CalendarDates.inOrder)
            windows[key] = now
        } catch {
            print("could not read the calendar: \(error)")
            guard reads[key] == ticket, windows[key] != nil else { return }
            windows[key]?.state = Self.unsupported(error) ? .unsupported : .failed
        }
    }

    /// A server from before M51 has no such route (404 not_found).
    static func unsupported(_ error: Error) -> Bool {
        if case ApiError.api(404, "not_found", _) = error { return true }
        return false
    }

    func loadUpcoming(_ channelId: String) async {
        guard let api else { return }
        do {
            upcoming[channelId] = try await api.calendarUpcoming(channelId: channelId, days: CalendarDates.upcomingDays, tz: tz())
        } catch {
            print("could not read the channel's upcoming events: \(error)")
        }
    }

    // MARK: changes made here

    func create(_ body: CalendarEventCreate) async throws -> CalendarEventOut {
        let event = try await requireApi().createCalendarEvent(body)
        put(event)
        return event
    }

    func update(_ eventId: String, _ patch: CalendarEventPatch) async throws -> CalendarEventOut {
        let event = try await requireApi().updateCalendarEvent(id: eventId, patch)
        put(event)
        return event
    }

    func remove(_ eventId: String) async throws {
        let known = find(eventId)
        try await requireApi().deleteCalendarEvent(id: eventId)
        drop(eventId, channelId: known?.channelId)
    }

    /// My alarm: minutes before (nil removes it).
    func setAlarm(_ eventId: String, minutes: Int?) async throws {
        let api = try requireApi()
        if let minutes {
            put(try await api.setCalendarAlarm(id: eventId, minutesBefore: minutes, tz: tz()))
        } else {
            try await api.clearCalendarAlarm(id: eventId)
            patchAlarm(eventId, nil)
        }
    }

    /// An event as it is now, from what is held or else from the server (a notification's event, §6).
    func fetch(_ eventId: String) async throws -> CalendarEventOut {
        if let known = find(eventId) { return known }
        return try await requireApi().calendarEvent(id: eventId)
    }

    private func requireApi() throws -> CalendarApi {
        guard let api else { throw ApiError.api(status: 404, code: "not_found", message: "The calendar is not available") }
        return api
    }

    // MARK: events (§5)

    func applyEvent(_ event: String, _ data: JSONValue) {
        switch event {
        case "calendar.event.updated":
            guard let payload = try? data.decode(CalendarEventUpdated.self) else { return }
            var shared = payload.event
            let me = me()
            shared.canEdit = me.map { payload.editorIds.contains($0) } ?? false
            shared.alarm = find(shared.id)?.alarm // mine is not in the event (§9 1.): it keeps the value held
            put(shared)
            if let channelId = shared.channelId { refreshUpcoming(channelId) }
        case "calendar.event.deleted":
            guard let payload = try? data.decode(CalendarEventDeleted.self) else { return }
            drop(payload.id, channelId: payload.channelId)
        case "calendar.alarm.updated":
            guard let payload = try? data.decode(CalendarAlarmUpdated.self) else { return }
            let before = find(payload.eventId)?.alarm?.status
            patchAlarm(payload.eventId, payload.alarm)
            if payload.alarm?.status == "fired" && before != "fired" { Task { await announce(payload.eventId) } }
        default:
            break
        }
    }

    /// A fired alarm: its event as known here, else read (it may be outside every window).
    private func announce(_ eventId: String) async {
        guard let onAlarm else { return }
        var event = find(eventId)
        if event == nil, let api { event = try? await api.calendarEvent(id: eventId) } // gone or no longer mine: nothing to say
        if let event { onAlarm(event) }
    }

    /// An event as it is now: into every window it overlaps (out of those it left), and into the counts that hold it.
    func put(_ event: CalendarEventOut) {
        for (key, window) in windows {
            let fits = (window.channelId == nil || window.channelId == event.channelId)
                && CalendarDates.overlaps(event, from: window.from, to: window.to)
            let rest = window.events.filter { $0.id != event.id }
            if !fits && rest.count == window.events.count { continue }
            windows[key]?.events = fits ? (rest + [event]).sorted(by: CalendarDates.inOrder) : rest
        }
        for (channelId, list) in upcoming where list.contains(where: { $0.id == event.id }) {
            upcoming[channelId] = list.map { $0.id == event.id ? event : $0 }
        }
    }

    private func drop(_ eventId: String, channelId: String?) {
        for (key, window) in windows where window.events.contains(where: { $0.id == eventId }) {
            windows[key]?.events = window.events.filter { $0.id != eventId }
        }
        for (id, list) in upcoming where list.contains(where: { $0.id == eventId }) {
            upcoming[id] = list.filter { $0.id != eventId }
        }
        if let channelId { refreshUpcoming(channelId) }
    }

    private func patchAlarm(_ eventId: String, _ alarm: CalendarAlarmOut?) {
        guard var known = find(eventId) else { return }
        known.alarm = alarm
        put(known)
    }

    private func refreshUpcoming(_ channelId: String) {
        if upcoming[channelId] != nil { Task { await loadUpcoming(channelId) } }
    }

    func find(_ eventId: String) -> CalendarEventOut? {
        for window in windows.values {
            if let event = window.events.first(where: { $0.id == eventId }) { return event }
        }
        for list in upcoming.values {
            if let event = list.first(where: { $0.id == eventId }) { return event }
        }
        return nil
    }

    // MARK: lifecycle

    /// After (re)connecting: every window and count is read again (events missed while away, §5).
    func online() {
        for key in windows.keys { Task { await read(key) } }
        for channelId in upcoming.keys { Task { await loadUpcoming(channelId) } }
    }

    /// I left the channel (or was removed): its events leave every window.
    func removeChannel(_ channelId: String) {
        for (key, window) in windows {
            if window.channelId == channelId {
                windows[key] = nil
            } else if window.events.contains(where: { $0.channelId == channelId }) {
                windows[key]?.events = window.events.filter { $0.channelId != channelId }
            }
        }
        upcoming[channelId] = nil
    }

    func stop() {
        windows = [:]
        upcoming = [:]
        reads = [:]
    }
}
