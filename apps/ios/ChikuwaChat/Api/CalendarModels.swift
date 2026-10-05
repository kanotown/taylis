import Foundation

/// The calendar (docs/CALENDAR.md; the server and the web in M51, this client in M52): my own events and my channels'
/// shared ones, one-off, timed or all-day, each with my own alarm.

/// My alarm on an event (§2, §6): `status` is pending | fired | cancelled.
struct CalendarAlarmOut: Codable, Equatable, Hashable {
    let minutesBefore: Int
    let fireAt: String
    let status: String
    /// M69 (§10.4): which occurrence of a recurring event `fireAt` is for (nil: a one-off event, or a server before M68).
    var occurrenceStart: String? = nil
}

/// An event as I see it (GET /calendar/events and the answers to my changes). calendar.event.updated carries the same
/// fields without `can_edit` and `alarm` (they differ per person, §9 1.): they then decode as false and nil and the hub
/// fills them in (editor_ids, the alarm held here).
struct CalendarEventOut: Identifiable, Equatable, Hashable {
    let id: String
    /// nil: my own calendar.
    let channelId: String?
    var channelName: String?
    let ownerId: String
    var title: String
    var allDay: Bool
    /// Timed events: instants.
    var startsAt: String?
    var endsAt: String?
    /// All-day events: "YYYY-MM-DD", the end included.
    var startDate: String?
    var endDate: String?
    var location: String?
    var description: String?
    let createdAt: String
    var updatedAt: String
    var canEdit: Bool
    var alarm: CalendarAlarmOut?
    /// M69 (CALENDAR.md §10.3): the series an occurrence belongs to (a one-off event: its own id; nil from a server before
    /// M68 — read `series`).
    var seriesId: String? = nil
    /// The occurrence's key: its original start ("2030-01-10T05:00:00Z", all-day "2030-01-10"); nil before M68.
    var occurrenceStart: String? = nil
    var recurring = false
    /// The series' rule (normalized RRULE) and the zone it repeats in.
    var rrule: String? = nil
    var tz: String? = nil

    /// The series' id (what the occurrence calls, the alarm and the scope dialog use).
    var series: String { seriesId ?? id }
    /// The occurrence's key, or the event's own start for a one-off event from an older server.
    var occurrenceKey: String { occurrenceStart ?? startsAt ?? startDate ?? "" }
}

extension CalendarEventOut: Decodable {
    private enum CodingKeys: String, CodingKey {
        case id, channelId, channelName, ownerId, title, allDay, startsAt, endsAt, startDate, endDate, location, description, createdAt,
             updatedAt, canEdit, alarm, seriesId, occurrenceStart, recurring, rrule, tz
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        channelId = try c.decodeIfPresent(String.self, forKey: .channelId)
        channelName = try c.decodeIfPresent(String.self, forKey: .channelName)
        ownerId = try c.decode(String.self, forKey: .ownerId)
        title = try c.decode(String.self, forKey: .title)
        allDay = try c.decode(Bool.self, forKey: .allDay)
        startsAt = try c.decodeIfPresent(String.self, forKey: .startsAt)
        endsAt = try c.decodeIfPresent(String.self, forKey: .endsAt)
        startDate = try c.decodeIfPresent(String.self, forKey: .startDate)
        endDate = try c.decodeIfPresent(String.self, forKey: .endDate)
        location = try c.decodeIfPresent(String.self, forKey: .location)
        description = try c.decodeIfPresent(String.self, forKey: .description)
        createdAt = try c.decode(String.self, forKey: .createdAt)
        updatedAt = try c.decode(String.self, forKey: .updatedAt)
        canEdit = try c.decodeIfPresent(Bool.self, forKey: .canEdit) ?? false
        alarm = try c.decodeIfPresent(CalendarAlarmOut.self, forKey: .alarm)
        // M68's fields, leniently: a server before M68 sends none of them (every event is then a one-off).
        seriesId = try? c.decodeIfPresent(String.self, forKey: .seriesId)
        occurrenceStart = try? c.decodeIfPresent(String.self, forKey: .occurrenceStart)
        recurring = (try? c.decodeIfPresent(Bool.self, forKey: .recurring)) ?? false
        rrule = try? c.decodeIfPresent(String.self, forKey: .rrule)
        tz = try? c.decodeIfPresent(String.self, forKey: .tz)
    }
}

/// calendar.event.updated (§5): the event as everyone who sees it sees it, and who may change it.
struct CalendarEventUpdated: Decodable {
    let event: CalendarEventOut
    let editorIds: [String]
}

/// calendar.event.deleted.
struct CalendarEventDeleted: Decodable {
    let id: String
    let channelId: String?
}

/// calendar.alarm.updated (to me only): my alarm set, recomputed, fired or removed (nil).
struct CalendarAlarmUpdated: Decodable {
    let eventId: String
    let channelId: String?
    let alarm: CalendarAlarmOut?
    /// Review v0.1.22 #9 (CALENDAR.md §10.11): the occurrence the alarm is for, resolved by the server with its edits (a
    /// changed occurrence's own title and times; a one-off: the event). Shaped like calendar.event.updated's `event` (no
    /// can_edit, no alarm). nil when there is none, and from a server before it (absent); read leniently.
    let occurrence: CalendarEventOut?

    private enum CodingKeys: String, CodingKey { case eventId, channelId, alarm, occurrence }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        eventId = try c.decode(String.self, forKey: .eventId)
        channelId = try c.decodeIfPresent(String.self, forKey: .channelId)
        alarm = try c.decodeIfPresent(CalendarAlarmOut.self, forKey: .alarm)
        occurrence = (try? c.decodeIfPresent(CalendarEventOut.self, forKey: .occurrence)) ?? nil
    }
}

/// The times of an event, in either form (POST and PATCH send one pair and null the other).
struct CalendarTiming: Equatable {
    var allDay: Bool
    var startsAt: String?
    var endsAt: String?
    var startDate: String?
    var endDate: String?

    var fields: [String: JSONValue] {
        func value(_ text: String?) -> JSONValue { text.map(JSONValue.string) ?? .null }
        return ["all_day": .bool(allDay), "starts_at": value(startsAt), "ends_at": value(endsAt), "start_date": value(startDate),
                "end_date": value(endDate)]
    }
}

/// POST /calendar/events (§4): `clientEventId` makes a retry return the same event; `tz` is the zone my alarm reads.
struct CalendarEventCreate: Equatable {
    var channelId: String?
    var title: String
    var timing: CalendarTiming
    var location: String?
    var description: String?
    var alarmMinutes: Int?
    var tz: String
    var clientEventId: String
    /// M69: the rule of a recurring event (nil: one-off; left out of the body then, as a server before M68 expects).
    var rrule: String? = nil

    var json: JSONValue {
        var fields = timing.fields
        fields["channel_id"] = channelId.map(JSONValue.string) ?? .null
        fields["title"] = .string(title)
        fields["location"] = location.map(JSONValue.string) ?? .null
        fields["description"] = description.map(JSONValue.string) ?? .null
        fields["alarm_minutes"] = alarmMinutes.map { .number(Double($0)) } ?? .null
        fields["tz"] = .string(tz)
        fields["client_event_id"] = .string(clientEventId)
        if let rrule { fields["rrule"] = .string(rrule) }
        return .object(fields)
    }
}

/// PATCH /calendar/events/{id}: the whole form (only the fields sent change; the calendar cannot move).
struct CalendarEventPatch: Equatable {
    var title: String
    var timing: CalendarTiming
    var location: String?
    var description: String?
    /// M69: a one-off event made recurring (its rule and the zone it repeats in); nil leaves the event one-off.
    var rrule: String? = nil
    var tz: String? = nil

    var json: JSONValue {
        var fields = timing.fields
        fields["title"] = .string(title)
        fields["location"] = location.map(JSONValue.string) ?? .null
        fields["description"] = description.map(JSONValue.string) ?? .null
        if let rrule {
            fields["rrule"] = .string(rrule)
            fields["tz"] = tz.map(JSONValue.string) ?? .null
        }
        return .object(fields)
    }
}

/// M69 (§10.1): which occurrences of a recurring event a change or a delete touches.
enum OccurrenceScope: String, CaseIterable, Identifiable {
    case this, following, all

    var id: String { rawValue }

    var label: String {
        switch self {
        case .this: tr("この予定")
        case .following: tr("これ以降すべて")
        case .all: tr("すべての予定")
        }
    }
}

/// PATCH /calendar/events/{series_id}/occurrences/{occurrence_start} (§10.3): only the fields the form changed (the times
/// are the occurrence's new ones), and the rule for 「これ以降」 / 「すべて」 when it changed (null: no longer repeats).
struct CalendarOccurrenceUpdate: Equatable {
    var scope: OccurrenceScope
    /// snake_case fields, as sent.
    var changes: [String: JSONValue] = [:]

    var json: JSONValue {
        var fields = changes
        fields["scope"] = .string(scope.rawValue)
        return .object(fields)
    }
}

/// M69 (§10.6): a private iCal feed, without its token. `scope` is all | personal.
struct CalendarFeedOut: Decodable, Equatable, Identifiable {
    let id: String
    let scope: String
    let createdAt: String
    let lastUsedAt: String?
}

/// POST /calendar/ical-feeds: the feed and its URL (in this answer only: the server keeps a hash).
struct CalendarFeedCreated: Decodable, Equatable {
    let feed: CalendarFeedOut
    let url: String
}
