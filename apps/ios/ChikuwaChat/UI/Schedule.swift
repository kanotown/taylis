import Foundation

/// 「後で送信」 presets and labels (M12d). Times are local; the server stores UTC.
enum Schedule {
    struct Preset: Identifiable {
        let key: String
        let label: String
        let at: Date
        var id: String { key }
    }

    private static func at(_ base: Date, dayOffset: Int, hour: Int, minute: Int = 0, calendar: Calendar) -> Date {
        let day = calendar.date(byAdding: .day, value: dayOffset, to: base) ?? base
        return calendar.date(bySettingHour: hour, minute: minute, second: 0, of: day) ?? day
    }

    /// A choice's text: its name, and its time when that says more (「1 時間後 (今日 21:20)」); 「明日 9:00」 once, not twice.
    static func choice(_ preset: Preset, now: Date = Date()) -> String {
        let when = label(preset.at, now: now)
        return when == preset.label ? preset.label : "\(preset.label) (\(when))"
    }

    /// Slack-like choices that are always in the future relative to `now`.
    static func presets(now: Date = Date(), calendar: Calendar = .current) -> [Preset] {
        var list: [Preset] = []
        let inOneHour = calendar.date(bySetting: .second, value: 0, of: now.addingTimeInterval(3600)) ?? now.addingTimeInterval(3600)
        list.append(Preset(key: "1h", label: tr("1 時間後"), at: inOneHour))
        let today18 = at(now, dayOffset: 0, hour: 18, calendar: calendar)
        if today18.timeIntervalSince(now) > 5 * 60 { list.append(Preset(key: "today18", label: tr("今日 18:00"), at: today18)) }
        list.append(Preset(key: "tomorrow9", label: tr("明日 9:00"), at: at(now, dayOffset: 1, hour: 9, calendar: calendar)))
        let weekday = calendar.component(.weekday, from: now) // 1 = Sunday
        var toMonday = (9 - weekday) % 7
        if toMonday == 0 { toMonday = 7 } // next Monday, never today
        list.append(Preset(key: "monday9", label: tr("来週月曜 9:00"), at: at(now, dayOffset: toMonday, hour: 9, calendar: calendar)))
        return list
    }

    /// 「リマインド」 choices (M12e): a little later, or a fresh morning.
    static func reminderPresets(now: Date = Date(), calendar: Calendar = .current) -> [Preset] {
        func soon(_ minutes: Int) -> Date {
            let date = now.addingTimeInterval(TimeInterval(minutes * 60))
            return calendar.date(bySetting: .second, value: 0, of: date) ?? date
        }
        var list = [
            Preset(key: "20m", label: tr("20 分後"), at: soon(20)),
            Preset(key: "1h", label: tr("1 時間後"), at: soon(60)),
            Preset(key: "3h", label: tr("3 時間後"), at: soon(180)),
            Preset(key: "tomorrow9", label: tr("明日 9:00"), at: at(now, dayOffset: 1, hour: 9, calendar: calendar)),
        ]
        let weekday = calendar.component(.weekday, from: now)
        var toMonday = (9 - weekday) % 7
        if toMonday == 0 { toMonday = 7 }
        list.append(Preset(key: "monday9", label: tr("来週月曜 9:00"), at: at(now, dayOffset: toMonday, hour: 9, calendar: calendar)))
        return list
    }

    private static var days: [String] { AppDates.weekdaysSundayFirst }

    /// "今日 18:00" / "明日 9:00" / "10月3日(土) 9:00" / "2027年1月4日(月) 9:00".
    static func label(_ date: Date, now: Date = Date(), calendar: Calendar = .current) -> String {
        let parts = calendar.dateComponents([.year, .month, .day, .hour, .minute, .weekday], from: date)
        let time = String(format: "%d:%02d", parts.hour ?? 0, parts.minute ?? 0)
        let start = calendar.startOfDay(for: now)
        let days = calendar.dateComponents([.day], from: start, to: calendar.startOfDay(for: date)).day ?? 0
        if days == 0 { return tr("今日 \(time)") }
        if days == 1 { return tr("明日 \(time)") }
        let year = parts.year != calendar.component(.year, from: now) ? tr("\(String(parts.year ?? 0))年") : ""
        return tr("\(year)\(parts.month ?? 0)月\(parts.day ?? 0)日(\(Self.days[(parts.weekday ?? 1) - 1])) \(time)")
    }

    static func label(iso: String, now: Date = Date()) -> String {
        guard let date = parseIsoDate(iso) else { return iso }
        return label(date, now: now)
    }
}
