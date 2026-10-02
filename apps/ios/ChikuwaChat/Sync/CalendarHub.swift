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
    /// M69 (CALENDAR.md §10.3): one occurrence of a series, it and the later ones, or all of them.
    func updateCalendarOccurrence(seriesId: String, occurrenceStart: String, _ body: CalendarOccurrenceUpdate) async throws -> CalendarEventOut
    func deleteCalendarOccurrence(seriesId: String, occurrenceStart: String, scope: OccurrenceScope) async throws
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
///
/// M69 (CALENDAR.md §10.4): a recurring event comes as one entry per occurrence (its own `id`, the series' `series_id`).
/// Only the server expands a series: any change to one (its calendar.event.updated has `recurring`, as do the answers to
/// my own changes) reads the windows it may touch again instead of patching them here. A series' alarm is one per person
/// and applies to all its occurrences.
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
        settle(event)
        return event
    }

    /// A whole event (a series: all its occurrences, 「すべての予定」 without moving it from an occurrence).
    func update(_ eventId: String, _ patch: CalendarEventPatch) async throws -> CalendarEventOut {
        let event = try await requireApi().updateCalendarEvent(id: eventId, patch)
        settle(event)
        return event
    }

    /// A whole event (a series: every occurrence).
    func remove(_ eventId: String) async throws {
        let known = findSeries(eventId)
        try await requireApi().deleteCalendarEvent(id: eventId)
        drop(eventId, channelId: known?.channelId)
    }

    /// M69: one occurrence of a series, it and the later ones, or all of them (the windows are read again).
    func updateOccurrence(_ seriesId: String, occurrenceStart: String, _ body: CalendarOccurrenceUpdate) async throws -> CalendarEventOut {
        let known = findSeries(seriesId)
        let event = try await requireApi().updateCalendarOccurrence(seriesId: seriesId, occurrenceStart: occurrenceStart, body)
        reloadFor(event.channelId ?? known?.channelId)
        return event
    }

    func removeOccurrence(_ seriesId: String, occurrenceStart: String, scope: OccurrenceScope) async throws {
        let known = findSeries(seriesId)
        try await requireApi().deleteCalendarOccurrence(seriesId: seriesId, occurrenceStart: occurrenceStart, scope: scope)
        let channelId = known?.channelId
        if scope == .all {
            drop(seriesId, channelId: channelId)
        } else {
            // The occurrence (or the later ones) leave at once; the windows' next read confirms it.
            dropWhere(channelId: channelId) {
                $0.series == seriesId && (scope == .this ? $0.occurrenceKey == occurrenceStart : $0.occurrenceKey >= occurrenceStart)
            }
            reloadFor(channelId)
        }
    }

    /// My alarm: minutes before (nil removes it). On a series it is the series' (every occurrence's): pass its id.
    func setAlarm(_ eventId: String, minutes: Int?) async throws {
        let api = try requireApi()
        if let minutes {
            let event = try await api.setCalendarAlarm(id: eventId, minutesBefore: minutes, tz: tz())
            if event.recurring { patchAlarm(event.series, event.alarm) } else { put(event) }
        } else {
            try await api.clearCalendarAlarm(id: eventId)
            patchAlarm(eventId, nil)
        }
    }

    /// My change's answer: a one-off event goes in as it is; a series is read again where it may show.
    private func settle(_ event: CalendarEventOut) {
        if event.recurring { reloadFor(event.channelId) } else { put(event) }
    }

    /// Reads again every window that may hold the channel's events (nil: my own calendar), and its count.
    private func reloadFor(_ channelId: String?) {
        for (key, window) in windows where window.channelId == nil || window.channelId == channelId {
            Task { await read(key) }
        }
        if let channelId { refreshUpcoming(channelId) }
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
            if shared.recurring {
                // A series changed (its rule, an occurrence, a split): only the server expands it.
                reloadFor(shared.channelId)
                return
            }
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
            let before = findSeries(payload.eventId)?.alarm
            patchAlarm(payload.eventId, payload.alarm)
            // A series fires once per occurrence: the same status for another occurrence is news.
            let again = before?.status == "fired" && before?.occurrenceStart == payload.alarm?.occurrenceStart
            if payload.alarm?.status == "fired" && !again {
                let occurrence = payload.alarm?.occurrenceStart
                Task { await announce(payload.eventId, occurrence: occurrence) }
            }
        default:
            break
        }
    }

    /// A fired alarm: its event (a series: the occurrence it is for) as known here, else read (it may be outside every
    /// window).
    private func announce(_ eventId: String, occurrence: String?) async {
        guard let onAlarm else { return }
        var event = occurrence.flatMap { findOccurrence(eventId, $0) } ?? find(eventId)
        if event == nil, let api { event = try? await api.calendarEvent(id: eventId) } // gone or no longer mine: nothing to say
        if let event { onAlarm(event) }
    }

    /// An event as it is now: into every window it overlaps (out of those it left), and into the counts that hold it. A
    /// one-off event also replaces what was left of its series (it no longer repeats).
    func put(_ event: CalendarEventOut) {
        let series = event.series
        let other = { (e: CalendarEventOut) in e.id != event.id && (event.recurring || e.series != series) }
        for (key, window) in windows {
            let fits = (window.channelId == nil || window.channelId == event.channelId)
                && CalendarDates.overlaps(event, from: window.from, to: window.to)
            let rest = window.events.filter(other)
            if !fits && rest.count == window.events.count { continue }
            windows[key]?.events = fits ? (rest + [event]).sorted(by: CalendarDates.inOrder) : rest
        }
        for (channelId, list) in upcoming where list.contains(where: { $0.id == event.id }) {
            upcoming[channelId] = list.map { $0.id == event.id ? event : $0 }
        }
    }

    /// An event gone (a series: every occurrence).
    private func drop(_ eventId: String, channelId: String?) {
        dropWhere(channelId: channelId) { $0.id == eventId || $0.series == eventId }
    }

    private func dropWhere(channelId: String?, _ gone: (CalendarEventOut) -> Bool) {
        for (key, window) in windows where window.events.contains(where: gone) {
            windows[key]?.events = window.events.filter { !gone($0) }
        }
        for (id, list) in upcoming where list.contains(where: gone) {
            upcoming[id] = list.filter { !gone($0) }
        }
        if let channelId { refreshUpcoming(channelId) }
    }

    /// My alarm on an event, or on every occurrence of a series.
    private func patchAlarm(_ eventId: String, _ alarm: CalendarAlarmOut?) {
        let mine = { (e: CalendarEventOut) in e.id == eventId || e.series == eventId }
        for (key, window) in windows where window.events.contains(where: mine) {
            windows[key]?.events = window.events.map { mine($0) ? Self.with($0, alarm: alarm) : $0 }
        }
        for (id, list) in upcoming where list.contains(where: mine) {
            upcoming[id] = list.map { mine($0) ? Self.with($0, alarm: alarm) : $0 }
        }
    }

    private static func with(_ event: CalendarEventOut, alarm: CalendarAlarmOut?) -> CalendarEventOut {
        var next = event
        next.alarm = alarm
        return next
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

    /// Any occurrence of a series (or the one-off event) known here.
    func findSeries(_ seriesId: String) -> CalendarEventOut? {
        find(seriesId) ?? all.first { $0.series == seriesId }
    }

    func findOccurrence(_ seriesId: String, _ occurrenceStart: String) -> CalendarEventOut? {
        all.first { $0.series == seriesId && $0.occurrenceKey == occurrenceStart }
    }

    private var all: [CalendarEventOut] { windows.values.flatMap(\.events) + upcoming.values.flatMap { $0 } }

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
