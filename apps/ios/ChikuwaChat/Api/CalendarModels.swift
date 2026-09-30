import Foundation

/// The calendar (docs/CALENDAR.md; the server and the web in M51, this client in M52): my own events and my channels'
/// shared ones, one-off, timed or all-day, each with my own alarm.

/// My alarm on an event (§2, §6): `status` is pending | fired | cancelled.
struct CalendarAlarmOut: Codable, Equatable, Hashable {
    let minutesBefore: Int
    let fireAt: String
    let status: String
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
}

extension CalendarEventOut: Decodable {
    private enum CodingKeys: String, CodingKey {
        case id, channelId, channelName, ownerId, title, allDay, startsAt, endsAt, startDate, endDate, location, description, createdAt,
             updatedAt, canEdit, alarm
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

    var json: JSONValue {
        var fields = timing.fields
        fields["channel_id"] = channelId.map(JSONValue.string) ?? .null
        fields["title"] = .string(title)
        fields["location"] = location.map(JSONValue.string) ?? .null
        fields["description"] = description.map(JSONValue.string) ?? .null
        fields["alarm_minutes"] = alarmMinutes.map { .number(Double($0)) } ?? .null
        fields["tz"] = .string(tz)
        fields["client_event_id"] = .string(clientEventId)
        return .object(fields)
    }
}

/// PATCH /calendar/events/{id}: the whole form (only the fields sent change; the calendar cannot move).
struct CalendarEventPatch: Equatable {
    var title: String
    var timing: CalendarTiming
    var location: String?
    var description: String?

    var json: JSONValue {
        var fields = timing.fields
        fields["title"] = .string(title)
        fields["location"] = location.map(JSONValue.string) ?? .null
        fields["description"] = description.map(JSONValue.string) ?? .null
        return .object(fields)
    }
}
