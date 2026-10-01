import Foundation

/// M54 (SCHEDULING.md, the web's ui/scheduling.ts): scheduling polls (日程調整) — the form's candidates, their labels and
/// the card's reading of the answers. Times are the device's local time (CalendarDates.zone); the server keeps UTC
/// instants (all-day candidates stay dates) and writes the labels itself in the zone the form sends, by the same rule
/// as slotLabel here.
enum SchedulePoll {
    /// The server's limits (messages/schedule.py).
    static let minSlots = 2
    static let maxSlots = 20
    static let minMinutes = 15
    static let maxMinutes = 12 * 60
    static let maxComment = 100
    static let maxQuestion = 200
    /// 10:00, an hour.
    static let defaultStart = 10 * 60
    static let defaultMinutes = 60
    /// The lengths the form offers.
    static let durations = [15, 30, 45, 60, 90, 120, 180, 240, 360]

    enum Answer: String, CaseIterable {
        case yes, maybe, no

        var mark: String {
            switch self {
            case .yes: "○"
            case .maybe: "△"
            case .no: "×"
            }
        }

        var name: String {
            switch self {
            case .yes: "参加できる"
            case .maybe: "未定"
            case .no: "参加できない"
            }
        }

        /// The table's cell: ○ → △ → × → unanswered.
        static func next(after answer: Answer?) -> Answer? {
            switch answer {
            case nil: .yes
            case .yes: .maybe
            case .maybe: .no
            case .no: nil
            }
        }
    }

    /// 「30 分」「1 時間」「1 時間半」「2 時間 15 分」.
    static func durationLabel(_ minutes: Int) -> String {
        let hours = minutes / 60, rest = minutes % 60
        if hours == 0 { return "\(rest) 分" }
        if rest == 0 { return "\(hours) 時間" }
        if rest == 30 { return "\(hours) 時間半" }
        return "\(hours) 時間 \(rest) 分"
    }

    /// The length choices, with a length the candidate already has (from `/日程 … 13:00-14:20`) kept in the list.
    static func lengthChoices(_ current: Int) -> [Int] {
        durations.contains(current) ? durations : (durations + [current]).sorted()
    }

    // MARK: the form's candidates

    /// One candidate in the form: a day, and its start (minutes since local midnight) and length, or the whole day.
    struct SlotDraft: Equatable, Hashable {
        var day: DayKey
        var allDay: Bool
        var start: Int
        var minutes: Int

        static func timed(_ day: DayKey, _ start: Int, minutes: Int = SchedulePoll.defaultMinutes) -> SlotDraft {
            SlotDraft(day: day, allDay: false, start: start, minutes: minutes)
        }

        static func wholeDay(_ day: DayKey) -> SlotDraft {
            SlotDraft(day: day, allDay: true, start: SchedulePoll.defaultStart, minutes: SchedulePoll.defaultMinutes)
        }

        var startDate: Date { CalendarDates.at(day, hour: start / 60, minute: start % 60) }
        var endDate: Date { startDate.addingTimeInterval(TimeInterval(minutes * 60)) }

        /// What makes two candidates the same (the server refuses the same instant and length, or the same day, twice).
        var key: String { allDay ? "d:\(day)" : "t:\(Int(startDate.timeIntervalSince1970)):\(minutes)" }
    }

    /// "HH:MM" → minutes since midnight; nil when not a time.
    static func minutes(_ text: String) -> Int? {
        let parts = text.split(separator: ":")
        guard parts.count == 2, let h = Int(parts[0]), let m = Int(parts[1]), (0...23).contains(h), (0...59).contains(m) else { return nil }
        return h * 60 + m
    }

    /// 「10/3 (土)」.
    static func shortDay(_ day: DayKey) -> String {
        let numbers = day.split(separator: "-").compactMap { Int($0) }
        guard numbers.count == 3 else { return day }
        return "\(numbers[1])/\(numbers[2]) (\(CalendarDates.weekdays[CalendarDates.weekday(day)]))"
    }

    /// 「10/3 (土) 14:00〜15:00」, 「10/5 (月) 終日」, past midnight 「22:00〜24:00」 / 「23:00〜翌1:30」 (the server's rule).
    static func slotLabel(_ slot: SlotDraft) -> String {
        if slot.allDay { return "\(shortDay(slot.day)) 終日" }
        let end = slot.endDate
        let endDay = CalendarDates.dayKey(end)
        let until: String
        if endDay == slot.day {
            until = CalendarDates.clock(end)
        } else if endDay == CalendarDates.addDays(slot.day, 1) && CalendarDates.clock(end) == "0:00" {
            until = "24:00"
        } else {
            until = "翌" + CalendarDates.clock(end)
        }
        return "\(shortDay(slot.day)) \(CalendarDates.clock(slot.startDate))〜\(until)"
    }

    /// Earliest first; a day's all-day candidate before its times.
    static func sortSlots(_ slots: [SlotDraft]) -> [SlotDraft] {
        slots.sorted { a, b in
            if a.day != b.day { return a.day < b.day }
            let ka = (a.allDay ? -1 : a.start, a.minutes), kb = (b.allDay ? -1 : b.start, b.minutes)
            return ka < kb
        }
    }

    /// The days picked: one press adds the day (with the form's time, or the whole day), the next takes all its
    /// candidates away.
    static func toggle(_ day: DayKey, in slots: [SlotDraft], allDay: Bool, start: Int, minutes: Int) -> [SlotDraft] {
        if slots.contains(where: { $0.day == day }) { return slots.filter { $0.day != day } }
        return sortSlots(slots + [SlotDraft(day: day, allDay: allDay, start: start, minutes: minutes)])
    }

    /// The time chosen above goes to every candidate; several times on one day become one when they turn all-day.
    static func applyToAll(_ slots: [SlotDraft], allDay: Bool? = nil, start: Int? = nil, minutes: Int? = nil) -> [SlotDraft] {
        var seen = Set<String>()
        let next = slots.map { slot -> SlotDraft in
            var slot = slot
            if let allDay { slot.allDay = allDay }
            if let start { slot.start = start }
            if let minutes { slot.minutes = minutes }
            return slot
        }
        return sortSlots(next.filter { slot in
            seen.insert(slot.allDay ? slot.day : "\(slot.day) \(slot.start) \(slot.minutes)").inserted
        })
    }

    /// Another time on the same day, right after `slot` (10:00 when that runs past midnight).
    static func addAfter(_ index: Int, in slots: [SlotDraft]) -> [SlotDraft] {
        guard slots.indices.contains(index) else { return slots }
        let slot = slots[index]
        var next = slot
        let end = CalendarDates.local.dateComponents([.hour, .minute], from: slot.endDate)
        next.start = (end.hour ?? 0) * 60 + (end.minute ?? 0)
        if next.start <= slot.start { next.start = defaultStart }
        return sortSlots(slots + [next])
    }

    /// What stops the form from being sent (the server's rules, said first here), or nil.
    static func problem(question: String, slots: [SlotDraft]) -> String? {
        if question.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return "題名を入れてください" }
        if slots.count < minSlots { return "候補を \(minSlots) つ以上選んでください" }
        if slots.count > maxSlots { return "候補は \(maxSlots) 個までです" }
        for slot in slots where !slot.allDay {
            if !(0..<(24 * 60)).contains(slot.start) { return "時刻を入れてください" }
            if slot.minutes < minMinutes || slot.minutes > maxMinutes { return "時間の長さは 15 分〜12 時間にしてください" }
        }
        if Set(slots.map(\.key)).count != slots.count { return "同じ候補が複数あります" }
        return nil
    }

    /// POST …/messages `poll.slots[]`: local times as UTC instants, all-day candidates as dates.
    struct SlotIn: Equatable {
        var startsAt: String?
        var endsAt: String?
        var date: String?

        var json: JSONValue {
            if let date { return .object(["date": .string(date)]) }
            return .object(["starts_at": .string(startsAt ?? ""), "ends_at": .string(endsAt ?? "")])
        }
    }

    static func slotIn(_ slot: SlotDraft) -> SlotIn {
        if slot.allDay { return SlotIn(date: slot.day) }
        return SlotIn(startsAt: CalendarDates.isoUtc(slot.startDate), endsAt: CalendarDates.isoUtc(slot.endDate))
    }

    /// `/日程 ゼミ 10/3 10/5 13:00-14:30` (Templates.readSchedule) → candidates: a time without an end lasts an hour.
    static func slots(from entries: [Templates.ScheduleEntry]) -> [SlotDraft] {
        var seen = Set<String>()
        var result: [SlotDraft] = []
        for entry in entries {
            let slot: SlotDraft
            if let from = entry.from {
                let length = entry.to.map { $0 - from } ?? defaultMinutes
                slot = .timed(entry.dayKey, from, minutes: min(maxMinutes, max(minMinutes, length)))
            } else {
                slot = .wholeDay(entry.dayKey)
            }
            if seen.insert(slot.key).inserted { result.append(slot) }
        }
        return sortSlots(result)
    }

    // MARK: the card

    struct Counts: Equatable {
        var yes = 0, maybe = 0, no = 0
    }

    static func counts(_ poll: PollOut) -> [Counts] {
        poll.options.indices.map { index in
            guard let answers = poll.answers, index < answers.count else { return Counts() }
            let a = answers[index]
            return Counts(yes: a.yesCount ?? a.yes?.count ?? 0, maybe: a.maybeCount ?? a.maybe?.count ?? 0, no: a.noCount ?? a.no?.count ?? 0)
        }
    }

    /// What `userId` said to candidate `index` (a named poll's lists).
    static func answer(of userId: String, _ index: Int, in poll: PollOut) -> Answer? {
        guard let answers = poll.answers, index < answers.count else { return nil }
        let a = answers[index]
        if a.yes?.contains(userId) == true { return .yes }
        if a.maybe?.contains(userId) == true { return .maybe }
        if a.no?.contains(userId) == true { return .no }
        return nil
    }

    /// My answer per candidate (nil = unanswered). A named poll's answers come with every change, events too, so they are
    /// read from the lists (always current); an anonymous poll lists nobody, and `my_answers` (responses to me only, kept
    /// by the store across events) is all there is.
    static func myAnswers(_ poll: PollOut, me: String?) -> [Answer?] {
        if !poll.isAnonymous {
            return poll.options.indices.map { index in me.flatMap { answer(of: $0, index, in: poll) } }
        }
        return poll.options.indices.map { index in
            guard let mine = poll.myAnswers, index < mine.count else { return nil }
            return mine[index].flatMap(Answer.init(rawValue:))
        }
    }

    /// My comment ("" = none), by the same rule as myAnswers.
    static func myComment(_ poll: PollOut, me: String?) -> String {
        if !poll.isAnonymous {
            guard let me else { return "" }
            return poll.comments?.first { $0.userId == me }?.text ?? ""
        }
        return poll.myComment ?? ""
    }

    /// My answers after pressing `answer` on candidate `index`: pressing the answer I already gave takes it back.
    static func press(_ current: [Answer?], index: Int, answer: Answer) -> [Answer?] {
        current.enumerated().map { i, value in i == index ? (value == answer ? nil : answer) : value }
    }

    /// PUT …/poll/answers `answers`: the answered candidates only.
    static func answersBody(_ answers: [Answer?]) -> [(index: Int, answer: Answer)] {
        answers.enumerated().compactMap { index, answer in answer.map { (index, $0) } }
    }

    /// The candidates with the most ○ (none while nobody said ○).
    static func bestSlots(_ poll: PollOut) -> [Int] {
        let yes = counts(poll).map(\.yes)
        let top = yes.max() ?? 0
        guard top > 0 else { return [] }
        return yes.indices.filter { yes[$0] == top }
    }

    /// How many answered (named: the respondents; anonymous: the most answers any candidate got).
    static func respondentCount(_ poll: PollOut) -> Int {
        if !poll.isAnonymous { return poll.respondents?.count ?? 0 }
        return counts(poll).map { $0.yes + $0.maybe + $0.no }.max() ?? 0
    }

    /// 「○ 2 · △ 0 · × 1」 for VoiceOver: 「○ 2 人、△ 0 人、× 1 人」.
    static func countsLabel(_ counts: Counts) -> String { "○ \(counts.yes) 人、△ \(counts.maybe) 人、× \(counts.no) 人" }
}
