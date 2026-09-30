import Foundation

/// M52: an event to show, from a calendar alarm's notification (PUSH_NOTIFICATIONS.md §4, kind = calendar).
struct CalendarOpen: Equatable {
    let eventId: String
    /// nil: my own calendar (the calendar screen shows it); else that channel's 「予定」 tab.
    let channelId: String?
}

/// M52: which calendars a screen offers (CALENDAR.md §3, §9 5.).
extension AppController {
    /// The calendar of the device on screen: the engine's (views under test pass their own).
    var calendarHub: CalendarHub? { engine?.calendar }

    /// The shared calendars I see: the public and private channels I belong to (DMs have none), by name.
    var readableCalendars: [ChannelState] {
        store.channels.values
            .filter { $0.isMember && Self.hasCalendar($0) }
            .sorted { ($0.channel.name ?? "").localizedStandardCompare($1.channel.name ?? "") == .orderedAscending }
    }

    /// The shared calendars I may add to: those I may post in (not archived, the posting policy followed).
    var writableCalendars: [ChannelState] {
        let admin = store.me?.role == "admin"
        return readableCalendars.filter { !$0.channel.archived && $0.canPostTopLevel(isAdmin: admin) }
    }

    /// Only public and private channels have a shared calendar (§9 5.).
    nonisolated static func hasCalendar(_ channel: ChannelState) -> Bool {
        channel.channel.type == "public" || channel.channel.type == "private"
    }
}
