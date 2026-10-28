import Foundation

/// M52: an event to show, from a calendar alarm's notification (PUSH_NOTIFICATIONS.md §4, kind = calendar), in the
/// workspace calendar (CalendarView). 2026-10-28: also 「このチャンネルの予定」 (no event), the calendar on that channel.
struct CalendarOpen: Equatable {
    /// nil: no event, only the channel's filter.
    let eventId: String?
    /// nil: my own calendar; else the channel's, which the calendar filters to.
    let channelId: String?

    /// The filter the calendar takes: the channel's when I see its calendar; nil (the filter as it is) otherwise.
    static func filter(_ open: CalendarOpen, readable: [String]) -> CalendarFilter? {
        guard let channelId = open.channelId, readable.contains(channelId) else { return nil }
        return .channel(channelId)
    }
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

    /// 2026-10-28 (CALENDAR.md §7): 「このチャンネルの予定」: the workspace calendar (home tab) filtered to the channel.
    func openChannelCalendar(_ channelId: String) {
        calendarOpen = CalendarOpen(eventId: nil, channelId: channelId)
        PushCenter.shared.pendingCalendar = true
    }

    /// The channel's events today and tomorrow (CalendarHub's upcoming, read when the conversation opens).
    func upcomingCount(_ channelId: String) -> Int { calendarHub?.upcomingOf(channelId)?.count ?? 0 }
}
