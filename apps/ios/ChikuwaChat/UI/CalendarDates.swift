import Foundation
import SwiftUI

/// A day, "YYYY-MM-DD" (the web's DayKey: sorts as text).
typealias DayKey = String

/// M52 (CALENDAR.md §7): the calendar's date math in the device's time zone, as the web's ui/calendarDates.ts. Weeks
/// start on Sunday (日曜始まり). A timed event covers the local days from its start to the instant before its end; an
/// all-day one its dates (the end included), whatever the zone.
enum CalendarDates {
    /// How far ahead the list (一覧) and a channel's 「予定」 tab read.
    static let listDays = 60
    /// The longest events (the server refuses longer ones: 400 calendar_event_too_long).
    static let maxTimedDays = 14
    static let maxAllDayDays = 60
    static let maxTitle = 200
    static let maxLocation = 200
    static let maxDescription = 4000
    /// Today and tomorrow (the 「予定 N」 count of a channel's tab).
    static let upcomingDays = 2

    static let weekdays = ["日", "月", "火", "水", "木", "金", "土"]

    /// Tests pin the zone (Asia/Tokyo, as the web's tests); the app uses the device's.
    nonisolated(unsafe) static var zoneOverride: TimeZone?
    static var zone: TimeZone { zoneOverride ?? .current }
    /// The zone my alarms are read in (sent as `tz`).
    static var zoneId: String { zone.identifier }

    /// The Gregorian calendar in the device's zone.
    static var local: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        return calendar
    }

    /// Day arithmetic on keys, free of any zone (a daylight-saving change never moves a day).
    private static let utc: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar
    }()

    // MARK: days

    private static func parts(_ key: DayKey) -> (year: Int, month: Int, day: Int) {
        let numbers = key.split(separator: "-").compactMap { Int($0) }
        guard numbers.count == 3 else { return (1970, 1, 1) }
        return (numbers[0], numbers[1], numbers[2])
    }

    private static func key(year: Int, month: Int, day: Int) -> DayKey {
        String(format: "%04d-%02d-%02d", year, month, day)
    }

    private static func utcDate(_ key: DayKey) -> Date {
        let p = parts(key)
        return utc.date(from: DateComponents(year: p.year, month: p.month, day: p.day))!
    }

    private static func utcKey(_ date: Date) -> DayKey {
        let p = utc.dateComponents([.year, .month, .day], from: date)
        return key(year: p.year!, month: p.month!, day: p.day!)
    }

    /// The local day of an instant.
    static func dayKey(_ date: Date) -> DayKey {
        let p = local.dateComponents([.year, .month, .day], from: date)
        return key(year: p.year!, month: p.month!, day: p.day!)
    }

    /// Local midnight of a day.
    static func parseDay(_ key: DayKey) -> Date {
        let p = parts(key)
        return local.date(from: DateComponents(year: p.year, month: p.month, day: p.day)) ?? utcDate(key)
    }

    /// A time on a day, locally.
    static func at(_ key: DayKey, hour: Int, minute: Int = 0) -> Date {
        let p = parts(key)
        return local.date(from: DateComponents(year: p.year, month: p.month, day: p.day, hour: hour, minute: minute)) ?? parseDay(key)
    }

    static func addDays(_ key: DayKey, _ days: Int) -> DayKey {
        utcKey(utc.date(byAdding: .day, value: days, to: utcDate(key))!)
    }

    /// Whole calendar days from `a` to `b`.
    static func daysBetween(_ a: DayKey, _ b: DayKey) -> Int {
        utc.dateComponents([.day], from: utcDate(a), to: utcDate(b)).day ?? 0
    }

    static func today(_ now: Date = Date()) -> DayKey { dayKey(now) }

    /// 0 = Sunday … 6 = Saturday.
    static func weekday(_ key: DayKey) -> Int { utc.component(.weekday, from: utcDate(key)) - 1 }

    static func dayOfMonth(_ key: DayKey) -> Int { parts(key).day }

    /// The Sunday on or before the day.
    static func weekStart(_ key: DayKey) -> DayKey { addDays(key, -weekday(key)) }

    /// The first day of the month `months` away from the month of `key`.
    static func addMonths(_ key: DayKey, _ months: Int) -> DayKey {
        let p = parts(key)
        let first = utc.date(from: DateComponents(year: p.year, month: p.month, day: 1))!
        return utcKey(utc.date(byAdding: .month, value: months, to: first)!)
    }

    static func sameMonth(_ a: DayKey, _ b: DayKey) -> Bool { a.prefix(7) == b.prefix(7) }

    /// The weeks (Sunday first) that hold the month of `key`: 4 to 6 rows of 7 days.
    static func monthGrid(_ key: DayKey) -> [[DayKey]] {
        let first = addMonths(key, 0)
        let last = addDays(addMonths(key, 1), -1)
        var weeks: [[DayKey]] = []
        var start = weekStart(first)
        while start <= last {
            weeks.append((0..<7).map { addDays(start, $0) })
            start = addDays(start, 7)
        }
        return weeks
    }

    /// The days the month view reads: [start, end) of its grid.
    static func monthRange(_ key: DayKey) -> (start: DayKey, end: DayKey) {
        let weeks = monthGrid(key)
        return (weeks[0][0], addDays(weeks[weeks.count - 1][6], 1))
    }

    /// An instant with the device's offset ("2026-10-01T00:00:00+09:00"): the server reads all-day dates in it.
    static func isoLocal(_ date: Date) -> String {
        let p = local.dateComponents([.year, .month, .day, .hour, .minute, .second], from: date)
        let offset = zone.secondsFromGMT(for: date) / 60
        let sign = offset >= 0 ? "+" : "-"
        return String(format: "%04d-%02d-%02dT%02d:%02d:%02d%@%02d:%02d", p.year!, p.month!, p.day!, p.hour!, p.minute!, p.second!,
                      sign, abs(offset) / 60, abs(offset) % 60)
    }

    /// An instant as UTC ("2026-10-01T05:00:00Z"), whole minutes (what the pickers mean).
    static func isoUtc(_ date: Date) -> String {
        let minute = Date(timeIntervalSince1970: (date.timeIntervalSince1970 / 60).rounded(.down) * 60)
        return ISO8601DateFormatter().string(from: minute)
    }

    // MARK: events

    static func startDate(_ event: CalendarEventOut) -> Date? { event.startsAt.flatMap(parseIsoDate) }
    static func endDate(_ event: CalendarEventOut) -> Date? { event.endsAt.flatMap(parseIsoDate) }

    /// The first and last local day an event covers.
    static func eventDays(_ event: CalendarEventOut) -> (first: DayKey, last: DayKey) {
        if event.allDay { return (event.startDate ?? "", event.endDate ?? event.startDate ?? "") }
        guard let start = startDate(event) else { return ("", "") }
        let end = (endDate(event) ?? start).addingTimeInterval(-0.001)
        return (dayKey(start), dayKey(end < start ? start : end))
    }

    static func coversDay(_ event: CalendarEventOut, _ day: DayKey) -> Bool {
        let days = eventDays(event)
        return days.first <= day && day <= days.last
    }

    /// The server's overlap rule (CALENDAR.md §4) for [from, to): timed events by instant, all-day ones by the local
    /// dates of `from` and of the instant before `to`.
    static func overlaps(_ event: CalendarEventOut, from: Date, to: Date) -> Bool {
        if !event.allDay {
            guard let start = startDate(event), let end = endDate(event) else { return false }
            return start < to && end > from
        }
        let first = dayKey(from)
        let last = dayKey(to.addingTimeInterval(-0.001))
        return (event.startDate ?? "") <= last && (event.endDate ?? "") >= first
    }

    /// "09:30" (for sorting).
    private static func hhmm(_ date: Date) -> String {
        let p = local.dateComponents([.hour, .minute], from: date)
        return String(format: "%02d:%02d", p.hour!, p.minute!)
    }

    private static func sortKey(_ event: CalendarEventOut) -> String {
        if event.allDay { return (event.startDate ?? "") + "T" }
        guard let start = startDate(event) else { return "" }
        return dayKey(start) + "T" + hhmm(start)
    }

    /// Earliest first; on a day, all-day events before timed ones; then by title.
    static func inOrder(_ a: CalendarEventOut, _ b: CalendarEventOut) -> Bool {
        let ka = sortKey(a), kb = sortKey(b)
        if ka != kb { return ka < kb }
        let byTitle = a.title.compare(b.title, locale: Locale(identifier: "ja"))
        return byTitle == .orderedSame ? a.id < b.id : byTitle == .orderedAscending
    }

    /// The events on a day: all-day ones and those that began earlier first, then by time.
    static func eventsOn(_ events: [CalendarEventOut], _ day: DayKey) -> [CalendarEventOut] {
        let rank = { (event: CalendarEventOut) in event.allDay || eventDays(event).first < day ? 0 : 1 }
        return events.filter { coversDay($0, day) }.sorted { a, b in
            rank(a) != rank(b) ? rank(a) < rank(b) : inOrder(a, b)
        }
    }

    /// The days of [start, end) that have events, each with its events in order (the list, a channel's tab).
    static func agenda(_ events: [CalendarEventOut], from start: DayKey, to end: DayKey) -> [(day: DayKey, events: [CalendarEventOut])] {
        (0..<max(0, daysBetween(start, end))).compactMap { offset in
            let day = addDays(start, offset)
            let list = eventsOn(events, day)
            return list.isEmpty ? nil : (day, list)
        }
    }

    // MARK: words

    /// "14:00" in local time.
    static func clock(_ date: Date) -> String {
        let p = local.dateComponents([.hour, .minute], from: date)
        return String(format: "%d:%02d", p.hour!, p.minute!)
    }

    static func clock(_ iso: String?) -> String { iso.flatMap(parseIsoDate).map(clock) ?? "" }

    /// "10月1日 (木)".
    static func dayLabel(_ key: DayKey) -> String {
        let p = parts(key)
        return "\(p.month)月\(p.day)日 (\(weekdays[weekday(key)]))"
    }

    /// "2026年10月".
    static func monthLabel(_ key: DayKey) -> String {
        let p = parts(key)
        return "\(p.year)年\(p.month)月"
    }

    /// What a row says of the time on `day`: 「終日」, 「14:00〜15:30」, 「〜15:30」 (began earlier), 「14:00〜」 (ends later).
    static func timeOnDay(_ event: CalendarEventOut, _ day: DayKey) -> String {
        if event.allDay { return "終日" }
        let days = eventDays(event)
        let start = days.first == day ? clock(event.startsAt) : ""
        let end = days.last == day ? clock(event.endsAt) : ""
        if start.isEmpty && end.isEmpty { return "終日" }
        return "\(start)〜\(end)"
    }

    /// The whole time of an event: 「10月1日 (木) 14:00〜15:00」, 「10月1日 (木)〜10月3日 (土) 終日」.
    static func eventWhen(_ event: CalendarEventOut) -> String {
        let days = eventDays(event)
        if event.allDay {
            return days.first == days.last ? "\(dayLabel(days.first)) 終日" : "\(dayLabel(days.first))〜\(dayLabel(days.last)) 終日"
        }
        guard let start = startDate(event), let end = endDate(event) else { return "" }
        let startText = "\(dayLabel(dayKey(start))) \(clock(start))"
        let endText = dayKey(end) == dayKey(start) ? clock(end) : "\(dayLabel(dayKey(end))) \(clock(end))"
        return "\(startText)〜\(endText)"
    }

    /// The in-app word when my alarm fires, as the server's push: 「14:00 ゼミ (#m2-進捗)」, 「終日 学会」. `event` nil (the
    /// occurrence is not known here, Review v0.1.22 #9): 「予定の通知があります (#…)」, never another occurrence's title.
    /// `channelName` is the calendar's channel from the channel list, used when the event names none.
    static func alarmText(_ event: CalendarEventOut?, channelName: String? = nil) -> String {
        guard let event else { return "予定の通知があります" + (channelName.map { " (#\($0))" } ?? "") }
        let when = event.allDay ? "終日" : clock(event.startsAt)
        return "\(when) \(event.title)" + ((event.channelName ?? channelName).map { " (#\($0))" } ?? "")
    }

    /// A channel's tab: 「予定 2」 while it has events today or tomorrow.
    static func eventsTabLabel(_ count: Int) -> String { count > 0 ? "予定 \(count)" : "予定" }

    // MARK: colours

    /// One fixed colour per channel (FNV-1a of its id, the same on every device, as the web); my own calendar is slate.
    static let palette = ["#2563eb", "#16a34a", "#dc2626", "#9333ea", "#0891b2", "#db2777", "#ea580c", "#a16207", "#4f46e5"]
    static let ownColor = "#64748b"

    static func colorHex(_ channelId: String?) -> String {
        guard let channelId else { return ownColor }
        var hash: UInt32 = 0x811c9dc5
        for unit in channelId.utf16 {
            hash ^= UInt32(unit)
            hash = hash &* 0x01000193
        }
        return palette[Int(hash % UInt32(palette.count))]
    }

    static func color(_ channelId: String?) -> Color {
        let hex = colorHex(channelId)
        let value = UInt32(hex.dropFirst(), radix: 16) ?? 0
        return Color(red: Double((value >> 16) & 0xff) / 255, green: Double((value >> 8) & 0xff) / 255, blue: Double(value & 0xff) / 255)
    }

    // MARK: alarms (§2, §7)

    struct AlarmChoice: Equatable, Hashable {
        let value: Int?
        let label: String
    }

    static let timedAlarms = [
        AlarmChoice(value: nil, label: "なし"),
        AlarmChoice(value: 0, label: "開始時"),
        AlarmChoice(value: 5, label: "5 分前"),
        AlarmChoice(value: 10, label: "10 分前"),
        AlarmChoice(value: 15, label: "15 分前"),
        AlarmChoice(value: 30, label: "30 分前"),
        AlarmChoice(value: 60, label: "1 時間前"),
        AlarmChoice(value: 1440, label: "前日 (24 時間前)"),
    ]

    /// An all-day event's alarm goes out at 8:00: the day before (1440) or on the day (-480).
    static let allDayAlarms = [
        AlarmChoice(value: nil, label: "なし"),
        AlarmChoice(value: 1440, label: "前日 8:00"),
        AlarmChoice(value: -480, label: "当日 8:00"),
    ]

    static func alarmChoices(allDay: Bool) -> [AlarmChoice] { allDay ? allDayAlarms : timedAlarms }

    static func alarmLabel(_ minutes: Int?, allDay: Bool) -> String {
        alarmChoices(allDay: allDay).first { $0.value == minutes }?.label ?? "なし"
    }

    /// The alarm kept when the event turns all-day or back (the server does the same, CALENDAR.md §2).
    static func remapAlarm(_ minutes: Int?, allDay: Bool) -> Int? {
        guard let minutes, minutes != 1440 else { return minutes }
        if allDay { return -480 }
        return minutes == -480 ? 60 : minutes
    }
}

/// Which events a screen shows: all, my own calendar, or one channel's (「すべて / 自分 / #チャンネル」).
enum CalendarFilter: Hashable {
    case all, mine
    case channel(String)

    func matches(_ event: CalendarEventOut) -> Bool {
        switch self {
        case .all: true
        case .mine: event.channelId == nil
        case .channel(let id): event.channelId == id
        }
    }
}

/// The form of an event (M52, the web's EventDraft): the times as the pickers hold them. An all-day event uses the days
/// of `start` and `end`; switching back to times keeps those.
struct EventDraft: Equatable {
    var title = ""
    var allDay = false
    var start: Date
    var end: Date
    /// nil: my own calendar.
    var channelId: String?
    var location = ""
    var description = ""
    var alarm: Int?
    /// M69 (CALENDAR.md §10): 「繰り返し」 (an occurrence's: its series' rule, read on the occurrence's day).
    var repetition: RepeatDraft

    var startDay: DayKey { CalendarDates.dayKey(start) }
    var endDay: DayKey { CalendarDates.dayKey(end) }

    /// A new event on `day`: the next whole hour for an hour (today), else 10:00.
    static func new(on day: DayKey, channelId: String? = nil, now: Date = Date()) -> EventDraft {
        var hour = 10
        if day == CalendarDates.dayKey(now) { hour = min(CalendarDates.local.component(.hour, from: now) + 1, 23) }
        let start = CalendarDates.at(day, hour: hour)
        let end = hour == 23 ? CalendarDates.at(day, hour: 23, minute: 59) : CalendarDates.at(day, hour: hour + 1)
        return EventDraft(start: start, end: end, channelId: channelId)
    }

    init(title: String = "", allDay: Bool = false, start: Date, end: Date, channelId: String? = nil, location: String = "",
         description: String = "", alarm: Int? = nil, repetition: RepeatDraft? = nil) {
        self.title = title
        self.allDay = allDay
        self.start = start
        self.end = end
        self.channelId = channelId
        self.location = location
        self.description = description
        self.alarm = alarm
        self.repetition = repetition ?? CalendarRecurrence.noRepeat(CalendarDates.dayKey(start))
    }

    /// An event read back into the form, in local time (an all-day one at 10:00〜11:00 should it turn timed).
    init(event: CalendarEventOut) {
        if event.allDay {
            start = CalendarDates.at(event.startDate ?? "", hour: 10)
            end = CalendarDates.at(event.endDate ?? event.startDate ?? "", hour: 11)
        } else {
            start = CalendarDates.startDate(event) ?? Date()
            end = CalendarDates.endDate(event) ?? start
        }
        title = event.title
        allDay = event.allDay
        channelId = event.channelId
        location = event.location ?? ""
        description = event.description ?? ""
        alarm = event.alarm?.minutesBefore
        repetition = CalendarRecurrence.toRepeat(event.rrule, start: CalendarDates.dayKey(start))
    }

    /// Moving the start carries the end along (the event keeps its length).
    func movingStart(to newStart: Date) -> EventDraft {
        var next = self
        next.start = newStart
        if allDay {
            let days = CalendarDates.daysBetween(startDay, CalendarDates.dayKey(newStart))
            next.end = CalendarDates.local.date(byAdding: .day, value: days, to: end) ?? end
        } else {
            next.end = end.addingTimeInterval(newStart.timeIntervalSince(start))
        }
        // 「しない」 follows the start, so 毎週 offers the new start's weekday once chosen.
        if repetition.kind == .none { next.repetition.weekdays = [CalendarDates.weekday(next.startDay)] }
        return next
    }

    /// 終日 on or off: an all-day event cannot end before it starts, and the alarm becomes one of the new kind.
    func settingAllDay(_ on: Bool) -> EventDraft {
        var next = self
        next.allDay = on
        if on && endDay < startDay { next.end = start }
        next.alarm = CalendarDates.remapAlarm(alarm, allDay: on)
        return next
    }

    private static func length(_ text: String) -> Int { text.unicodeScalars.count }

    /// What stops the form from being saved (the server's rules, said first here), or nil.
    var problem: String? {
        let title = title.trimmingCharacters(in: .whitespacesAndNewlines)
        if title.isEmpty { return "題名を入れてください" }
        if Self.length(title) > CalendarDates.maxTitle { return "題名は \(CalendarDates.maxTitle) 文字までです" }
        if Self.length(location.trimmingCharacters(in: .whitespacesAndNewlines)) > CalendarDates.maxLocation {
            return "場所は \(CalendarDates.maxLocation) 文字までです"
        }
        if Self.length(description.trimmingCharacters(in: .whitespacesAndNewlines)) > CalendarDates.maxDescription {
            return "説明は \(CalendarDates.maxDescription) 文字までです"
        }
        if let repeatProblem = CalendarRecurrence.problem(repetition, start: startDay) { return repeatProblem }
        if allDay {
            if endDay < startDay { return "終了日は開始日より後にしてください" }
            if CalendarDates.daysBetween(startDay, endDay) >= CalendarDates.maxAllDayDays { return "終日の予定は \(CalendarDates.maxAllDayDays) 日までです" }
            return nil
        }
        let startMinute = CalendarDates.isoUtc(start), endMinute = CalendarDates.isoUtc(end)
        if endMinute <= startMinute { return "終了は開始より後にしてください" }
        if end.timeIntervalSince(start) > Double(CalendarDates.maxTimedDays) * 86_400 { return "時刻の予定は \(CalendarDates.maxTimedDays) 日までです" }
        return nil
    }

    var timing: CalendarTiming {
        if allDay { return CalendarTiming(allDay: true, startDate: startDay, endDate: endDay) }
        return CalendarTiming(allDay: false, startsAt: CalendarDates.isoUtc(start), endsAt: CalendarDates.isoUtc(end))
    }

    private static func optional(_ text: String) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    /// POST /calendar/events: local times become UTC instants, all-day days stay dates.
    func create(tz: String, clientEventId: String) -> CalendarEventCreate {
        CalendarEventCreate(channelId: channelId, title: title.trimmingCharacters(in: .whitespacesAndNewlines), timing: timing,
                            location: Self.optional(location), description: Self.optional(description), alarmMinutes: alarm, tz: tz,
                            clientEventId: clientEventId, rrule: rrule)
    }

    /// M69: the rule the picker says (nil: しない).
    var rrule: String? { CalendarRecurrence.toRrule(repetition, start: startDay) }

    /// M69 (§10.8): what the form changed against the event as it was opened, and only that, as the occurrence call's
    /// fields (「この予定」 must not mark the fields it left alone as its own). The time goes whole when any of it changed.
    func changes(from before: EventDraft) -> [String: JSONValue] {
        var out: [String: JSONValue] = [:]
        let trim = { (text: String) in text.trimmingCharacters(in: .whitespacesAndNewlines) }
        if trim(title) != trim(before.title) { out["title"] = .string(trim(title)) }
        if trim(location) != trim(before.location) { out["location"] = Self.optional(location).map(JSONValue.string) ?? .null }
        if trim(description) != trim(before.description) { out["description"] = Self.optional(description).map(JSONValue.string) ?? .null }
        if timing != before.timing { out.merge(timing.fields) { _, new in new } }
        return out
    }

    /// PATCH /calendar/events/{id}: the whole form (its calendar cannot move).
    var patch: CalendarEventPatch {
        CalendarEventPatch(title: title.trimmingCharacters(in: .whitespacesAndNewlines), timing: timing, location: Self.optional(location),
                           description: Self.optional(description))
    }
}
