import Foundation

/// Do not disturb (M12c): a manual pause or the daily quiet hours, evaluated in the user's own zone.
/// Same rule as the server: an overnight window belongs to the day it starts on.
enum DND {
    static let dayLabels = ["月", "火", "水", "木", "金", "土", "日"]

    static func minutes(_ hhmm: String) -> Int {
        let parts = hhmm.split(separator: ":").compactMap { Int($0) }
        guard parts.count == 2 else { return 0 }
        return parts[0] * 60 + parts[1]
    }

    static func hhmm(_ minutes: Int) -> String { String(format: "%02d:%02d", minutes / 60, minutes % 60) }

    /// Local weekday (0 = Monday) and minutes after midnight in `tz`; nil when the zone is unknown.
    static func localClock(_ now: Date, tz: String) -> (weekday: Int, minutes: Int)? {
        guard let zone = TimeZone(identifier: tz) else { return nil }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        let parts = calendar.dateComponents([.weekday, .hour, .minute], from: now)
        guard let weekday = parts.weekday, let hour = parts.hour, let minute = parts.minute else { return nil }
        return ((weekday + 5) % 7, hour * 60 + minute) // Calendar: 1 = Sunday
    }

    static func inQuietHours(_ hours: QuietHours, now: Date = Date()) -> Bool {
        let start = minutes(hours.start)
        let end = minutes(hours.end)
        if start == end { return false }
        guard let clock = localClock(now, tz: hours.tz) else { return false }
        let days = Set(hours.days.isEmpty ? Array(0..<7) : hours.days)
        if start < end { return start <= clock.minutes && clock.minutes < end && days.contains(clock.weekday) }
        if clock.minutes >= start { return days.contains(clock.weekday) }
        return clock.minutes < end && days.contains((clock.weekday + 6) % 7)
    }

    static func isActive(_ user: UserPublic?, now: Date = Date()) -> Bool {
        guard let user else { return false }
        if let raw = user.dndUntil, let until = parseIsoDate(raw), until > now { return true }
        if let hours = user.quietHours { return inQuietHours(hours, now: now) }
        return false
    }

    enum Pause: String, CaseIterable, Identifiable {
        case halfHour, hour, twoHours, tomorrow
        var id: String { rawValue }
        var label: String {
            switch self {
            case .halfHour: "30 分"
            case .hour: "1 時間"
            case .twoHours: "2 時間"
            case .tomorrow: "明日 8:00"
            }
        }
        func until(from now: Date = Date()) -> Date {
            let calendar = Calendar.current
            switch self {
            case .halfHour: return now.addingTimeInterval(30 * 60)
            case .hour: return now.addingTimeInterval(3600)
            case .twoHours: return now.addingTimeInterval(2 * 3600)
            case .tomorrow:
                let tomorrow = calendar.date(byAdding: .day, value: 1, to: now) ?? now
                return calendar.date(bySettingHour: 8, minute: 0, second: 0, of: tomorrow) ?? tomorrow
            }
        }
    }

    /// "22:00〜07:00 (月〜金)" for the profile card.
    static func label(_ hours: QuietHours) -> String {
        let days = (hours.days.isEmpty || hours.days.count == 7) ? "" : " (" + hours.days.sorted().map { dayLabels[$0] }.joined() + ")"
        return "\(hours.start)〜\(hours.end)\(days)"
    }
}
