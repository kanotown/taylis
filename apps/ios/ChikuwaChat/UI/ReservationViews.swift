import SwiftUI

/// M112 (docs/RESERVATIONS.md §6): the pure parts of 「予約」 — the booking choices, the hours of a day, my reservations,
/// the operators' to-do and the words (the same rules as the web's ui/reservationPools.ts). Times are the device's.
enum ReservationRules {
    static let hour: TimeInterval = 3600

    private static func date(_ iso: String?) -> Date? { iso.flatMap(parseIsoDate) }

    static func dayStart(_ date: Date, calendar: Calendar = .current) -> Date { calendar.startOfDay(for: date) }

    /// Today and the next `horizonDays`.
    static func bookingDays(now: Date, horizonDays: Int, calendar: Calendar = .current) -> [Date] {
        let today = dayStart(now, calendar: calendar)
        return (0...horizonDays).compactMap { calendar.date(byAdding: .day, value: $0, to: today) }
    }

    /// 「今日」 「明日」 or 「10/7 (水)」.
    static func dayLabel(_ day: Date, now: Date, calendar: Calendar = .current) -> String {
        let diff = calendar.dateComponents([.day], from: dayStart(now, calendar: calendar), to: dayStart(day, calendar: calendar)).day ?? 0
        if diff == 0 { return tr("今日") }
        if diff == 1 { return tr("明日") }
        let weekdays = AppDates.weekdaysSundayFirst
        let c = calendar.dateComponents([.month, .day, .weekday], from: day)
        return "\(c.month ?? 0)/\(c.day ?? 0) (\(weekdays[((c.weekday ?? 1) - 1) % 7]))"
    }

    static func hm(_ date: Date, calendar: Calendar = .current) -> String {
        let c = calendar.dateComponents([.hour, .minute], from: date)
        return String(format: "%02d:%02d", c.hour ?? 0, c.minute ?? 0)
    }

    /// 「13:00」 today, else 「10/7 (水) 13:00」.
    static func when(_ iso: String, now: Date, calendar: Calendar = .current) -> String {
        guard let d = date(iso) else { return "" }
        return dayStart(d, calendar: calendar) == dayStart(now, calendar: calendar) ? hm(d, calendar: calendar)
            : "\(dayLabel(d, now: now, calendar: calendar)) \(hm(d, calendar: calendar))"
    }

    /// 「13:00〜16:00」 today, else 「10/7 (水) 13:00〜16:00」.
    static func span(_ startIso: String?, _ endIso: String?, now: Date, calendar: Calendar = .current) -> String {
        guard let start = date(startIso), let end = date(endIso) else { return "" }
        let day = dayStart(start, calendar: calendar) == dayStart(now, calendar: calendar) ? "" : "\(dayLabel(start, now: now, calendar: calendar)) "
        return tr("\(day)\(hm(start, calendar: calendar))〜\(hm(end, calendar: calendar))")
    }

    /// Bookings still counting (booked or on a seat).
    static func live(_ pool: PoolOut) -> [ReservationOut] {
        pool.bookings.filter { ["booked", "holding", "returning"].contains($0.status) }
    }

    /// Seats promised over [start, end): bookings on it and walk-ins whose guarantee reaches into it.
    private static func promised(_ pool: PoolOut, _ start: Date, _ end: Date, now: Date) -> Int {
        var count = live(pool).filter { b in
            guard let s = date(b.startAt), let e = date(b.endAt) else { return false }
            return s < end && e > start
        }.count
        let from = max(start, now)
        count += pool.holders.filter { h in
            h.kind == "walkin" && h.status == "holding" && (date(h.guaranteeUntil).map { $0 > from } ?? false) && from < end
        }.count
        return count
    }

    /// Whether every hour of [start, start + hours) has a seat left (the server's check, as far as the app knows).
    static func fits(_ pool: PoolOut, start: Date, hours: Int, now: Date) -> Bool {
        (0..<hours).allSatisfy { i in
            let from = start.addingTimeInterval(Double(i) * hour)
            return promised(pool, from, from.addingTimeInterval(hour), now: now) + 1 <= pool.capacity
        }
    }

    static func horizonEnd(_ pool: PoolOut, now: Date, calendar: Calendar = .current) -> Date {
        calendar.date(byAdding: .day, value: pool.horizonDays + 1, to: dayStart(now, calendar: calendar)) ?? now
    }

    struct StartChoice: Equatable, Identifiable {
        let start: Date
        let full: Bool
        var id: Date { start }
    }

    /// The starts on `day`: every hour from the current one (today) on.
    static func starts(_ pool: PoolOut, day: Date, now: Date, calendar: Calendar = .current) -> [StartChoice] {
        let first = dayStart(day, calendar: calendar)
        let hourNow = calendar.dateInterval(of: .hour, for: now)?.start ?? now
        let limit = horizonEnd(pool, now: now, calendar: calendar)
        return (0..<24).compactMap { h in
            guard let start = calendar.date(byAdding: .hour, value: h, to: first), start >= hourNow, start < limit,
                  calendar.isDate(start, inSameDayAs: first) else { return nil }
            return StartChoice(start: start, full: !fits(pool, start: start, hours: 1, now: now))
        }
    }

    /// How long a booking from `start` can be: 1 h up to max_hours, stopping at the first full hour and the horizon.
    static func durations(_ pool: PoolOut, start: Date, now: Date, calendar: Calendar = .current) -> [Int] {
        var out: [Int] = []
        let limit = horizonEnd(pool, now: now, calendar: calendar)
        for hours in 1...max(1, pool.maxHours) {
            if start.addingTimeInterval(Double(hours) * hour) > limit || !fits(pool, start: start, hours: hours, now: now) { break }
            out.append(hours)
        }
        return out
    }

    /// One hour of the phone's day list: who is booked or on a seat then.
    struct HourRow: Equatable, Identifiable {
        let start: Date
        let rows: [ReservationOut]
        var id: Date { start }
    }

    /// The hours of `day` with their bookings and walk-ins (from assignment to the end of the guarantee, or now).
    static func hours(_ pool: PoolOut, day: Date, now: Date, calendar: Calendar = .current) -> [HourRow] {
        let first = dayStart(day, calendar: calendar)
        var spans: [(ReservationOut, Date, Date)] = []
        for b in pool.bookings { if let s = date(b.startAt), let e = date(b.endAt) { spans.append((b, s, e)) } }
        for h in pool.holders where h.kind == "walkin" {
            if let s = date(h.assignedAt) { spans.append((h, s, max(date(h.guaranteeUntil) ?? now, now))) }
        }
        return (0..<24).compactMap { h in
            guard let start = calendar.date(byAdding: .hour, value: h, to: first) else { return nil }
            let end = start.addingTimeInterval(hour)
            return HourRow(start: start, rows: spans.filter { $0.1 < end && $0.2 > start }.map(\.0))
        }
    }

    struct Mine: Equatable {
        var walkin: ReservationOut?
        var bookings: [ReservationOut]
    }

    static func mine(_ pool: PoolOut, me: String?) -> Mine {
        let walkin = (pool.holders + pool.waiting).first { $0.id == pool.myReservationId }
        return Mine(walkin: walkin, bookings: live(pool).filter { $0.userId == me })
    }

    /// What my walk-in request says.
    static func walkinText(_ row: ReservationOut, pool: PoolOut, now: Date) -> String {
        if row.status == "waiting" {
            switch row.step {
            case "assign": return row.until.map { tr("空きあり (〜\(when($0, now: now)) まで) · 担当者の割り当て待ち") } ?? tr("空きあり · 担当者の割り当て待ち")
            case "swap": return row.ready ? tr("まもなく担当者が割り当てます") : tr("前の人の保証時間の後に割り当てられます")
            default: return tr("順番待ち \(row.position.map(String.init) ?? "?") 番目")
            }
        }
        if row.status == "returning" { return tr("返却済み · 担当者が外すのを待っています") }
        if let evict = row.evictAt { return tr("\(when(evict, now: now)) 以降に外されます") }
        return row.guaranteeUntil.map { tr("利用中 (〜\(when($0, now: now)) まで保証)") } ?? tr("利用中")
    }

    /// What a booking of mine says.
    static func bookingText(_ row: ReservationOut, now: Date) -> String {
        let s = span(row.startAt, row.endAt, now: now)
        switch row.status {
        case "holding": return tr("\(s) · 利用中")
        case "returning": return tr("\(s) · 返却済み")
        default:
            if let start = date(row.startAt), start <= now { return tr("\(s) · 開始 (担当者の割り当て待ち)") }
            return s
        }
    }

    /// To-dos due now in the pools I operate (the tile's number).
    static func todoCount(_ pools: [PoolOut]) -> Int { pools.reduce(0) { $0 + $1.todos.filter { !$0.upcoming }.count } }

    static func row(_ pool: PoolOut, _ id: String?) -> ReservationOut? {
        guard let id else { return nil }
        return pool.holders.first { $0.id == id } ?? pool.waiting.first { $0.id == id } ?? pool.bookings.first { $0.id == id }
    }

    private static var reasons: [String: String] { ["free": tr("空きあり"), "returned": tr("返却済み"), "booking_ended": tr("予約時間が終了"), "guarantee_over": tr("保証時間が終了")] }

    /// One to-do as a line (the web's todoLine).
    static func todoLine(_ todo: ReservationTodo, pool: PoolOut, name: (String) -> String, now: Date) -> String {
        func who(_ id: String?) -> String {
            guard let row = row(pool, id) else { return tr("(不明)") }
            return row.email.map { tr("\(name(row.userId)) さん (\($0))") } ?? tr("\(name(row.userId)) さん")
        }
        let target = row(pool, todo.assignId)
        let booked = target?.kind == "booking" ? tr(" · 予約 \(span(target?.startAt, target?.endAt, now: now))") : ""
        let head = todo.upcoming ? tr("\(when(todo.dueAt, now: now)) から: ") : ""
        let reason = reasons[todo.reason] ?? ""
        switch todo.action {
        case "assign": return tr("\(head)\(who(todo.assignId)) に割り当てる\(booked)")
        case "swap": return tr("\(head)\(who(todo.removeId)) を外して \(who(todo.assignId)) に割り当てる (\(reason))\(booked)")
        default: return tr("\(head)\(who(todo.removeId)) を外す (\(reason))")
        }
    }

    static func todoButton(_ todo: ReservationTodo) -> String {
        switch todo.action {
        case "assign": tr("割り当てた")
        case "remove": tr("外した")
        default: tr("入れ替えた")
        }
    }
}

/// 「予約」: per pool, my reservations, 「予約する」 / 「今すぐ (順番待ち)」, the operators' to-do and a day's hours.
/// Pool settings are on the desktop / web only.
struct ReservationsView: View {
    static let selectionId = "reservations"
    @Bindable var controller: AppController

    var body: some View {
        Group {
            if let pools = controller.store.reservationPools {
                if pools.isEmpty {
                    ContentUnavailableView("予約の枠はありません", systemImage: "ticket",
                                           description: Text("枠は管理者が Desktop / Web で作ります"))
                } else {
                    List {
                        ForEach(pools) { pool in PoolSection(controller: controller, pool: pool) }
                    }
                    .listStyle(.insetGrouped)
                }
            } else {
                ProgressView()
            }
        }
        .navigationTitle("予約")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await controller.engine?.loadReservationPools() }
        .task { await controller.engine?.loadReservationPools() }
    }
}

/// One pool's sections.
struct PoolSection: View {
    @Bindable var controller: AppController
    let pool: PoolOut
    @State private var day = ReservationRules.dayStart(Date())
    @State private var booking = false
    @State private var busy = false
    @State private var confirm: Confirm?

    struct Confirm: Identifiable {
        let id = UUID()
        let text: String
        let label: String
        var destructive = false
        let run: () async -> Void
    }

    private func name(_ userId: String) -> String { controller.store.statusUser(userId)?.displayName ?? tr("(不明)") }

    private func run(_ call: @escaping () async -> Void) {
        guard !busy else { return }
        busy = true
        Task {
            await call()
            busy = false
        }
    }

    var body: some View {
        let now = Date()
        let mine = ReservationRules.mine(pool, me: controller.store.me?.id)
        Section {
            HStack(spacing: 8) {
                Button { booking = true } label: { Label("予約する", systemImage: "calendar.badge.plus") }
                    .buttonStyle(.borderedProminent)
                    .disabled(!pool.enabled || busy || mine.bookings.count >= 2 || controller.isGuest)
                if mine.walkin == nil {
                    Button("今すぐ (順番待ち)") { run { _ = await controller.reservePool(pool.id) } }
                        .buttonStyle(.bordered)
                        .disabled(!pool.enabled || busy || controller.isGuest)
                }
            }
            ForEach(mine.bookings) { row in
                HStack {
                    Text(ReservationRules.bookingText(row, now: now)).font(.subheadline)
                    Spacer()
                    if row.status == "booked" || row.status == "holding" {
                        Button("延長") { run { _ = await controller.extendReservation(row.id) } }
                            .buttonStyle(.bordered).disabled(!row.canExtend || busy)
                    }
                    if row.status == "booked" {
                        Button("取り消す") {
                            confirm = Confirm(text: tr("この予約を取り消しますか？"), label: tr("取り消す"), destructive: true,
                                              run: { _ = await controller.reservationAction(row.id, "cancel") })
                        }.buttonStyle(.bordered)
                    } else if row.status == "holding" {
                        Button("返却する") {
                            confirm = Confirm(text: tr("使い終わりましたか？ 担当者に外してもらいます。"), label: tr("返却する"),
                                              run: { _ = await controller.reservationAction(row.id, "return") })
                        }.buttonStyle(.bordered)
                    }
                }
                .accessibilityElement(children: .contain)
            }
            if let walkin = mine.walkin {
                HStack {
                    Text(tr("今すぐ: ") + ReservationRules.walkinText(walkin, pool: pool, now: now)).font(.subheadline)
                    Spacer()
                    if walkin.status == "waiting" {
                        Button("取り消す") { run { _ = await controller.reservationAction(walkin.id, "cancel") } }.buttonStyle(.bordered)
                    } else if walkin.status == "holding" {
                        Button("返却する") {
                            confirm = Confirm(text: tr("使い終わりましたか？ 担当者に外してもらいます。"), label: tr("返却する"),
                                              run: { _ = await controller.reservationAction(walkin.id, "return") })
                        }.buttonStyle(.bordered)
                    }
                }
            }
        } header: {
            HStack {
                Image(systemName: "ticket")
                Text(pool.name)
                if !pool.enabled { Text("停止中").foregroundStyle(.secondary) }
            }
        } footer: {
            Text("毎時 0 分から \(pool.maxHours) 時間まで、2 週間先まで、1 人 2 件まで。「今すぐ」は空いている枠を次の予約が始まるまで使えます。")
        }
        .disabled(busy)
        .sheet(isPresented: $booking) { BookingSheet(controller: controller, pool: pool, initialDay: day) }
        .confirmationDialog(confirm?.text ?? "", isPresented: Binding(get: { confirm != nil }, set: { if !$0 { confirm = nil } }),
                            titleVisibility: .visible, presenting: confirm) { which in
            Button(which.label, role: which.destructive ? .destructive : nil) { run(which.run) }
            Button("キャンセル", role: .cancel) {}
        }

        if pool.canOperate {
            Section("担当者の作業") {
                if pool.todos.isEmpty { Text("今はありません").foregroundStyle(.secondary) }
                ForEach(pool.todos) { todo in
                    HStack(alignment: .top) {
                        VStack(alignment: .leading, spacing: 2) {
                            if todo.upcoming { Text("まもなく").font(.caption2.bold()).foregroundStyle(Color.accentColor) }
                            Text(ReservationRules.todoLine(todo, pool: pool, name: name, now: now)).font(.subheadline)
                                .textSelection(.enabled)
                        }
                        Spacer()
                        Button(ReservationRules.todoButton(todo)) { press(todo) }
                            .buttonStyle(todo.upcoming ? AnyPrimitiveButtonStyle(.bordered) : AnyPrimitiveButtonStyle(.borderedProminent))
                            .disabled(busy || tooEarly(todo, now: now))
                    }
                }
            }
        }

        Section {
            Picker("日付", selection: $day) {
                ForEach(ReservationRules.bookingDays(now: now, horizonDays: pool.horizonDays), id: \.self) { d in
                    Text(ReservationRules.dayLabel(d, now: now)).tag(d)
                }
            }
            ForEach(ReservationRules.hours(pool, day: day, now: now)) { hour in
                if hour.start >= Calendar.current.dateInterval(of: .hour, for: now)?.start ?? now || !hour.rows.isEmpty {
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        Text(ReservationRules.hm(hour.start)).font(.caption.monospacedDigit()).foregroundStyle(.secondary).frame(width: 44, alignment: .leading)
                        Text("\(hour.rows.count)/\(pool.capacity)").font(.caption.monospacedDigit())
                            .foregroundStyle(hour.rows.count >= pool.capacity ? Color.red : Color.secondary).frame(width: 36, alignment: .leading)
                        Text(hour.rows.map { name($0.userId) + ($0.kind == "walkin" ? tr(" (今すぐ)") : "") }.joined(separator: tr("、")))
                            .font(.caption).lineLimit(2)
                    }
                    .accessibilityElement(children: .combine)
                }
            }
        } header: {
            Text("\(pool.name) の空き")
        }
    }

    private func tooEarly(_ todo: ReservationTodo, now: Date) -> Bool {
        guard todo.upcoming, let start = ReservationRules.row(pool, todo.assignId)?.startAt.flatMap(parseIsoDate) else { return false }
        return start.timeIntervalSince(now) > 600
    }

    private func press(_ todo: ReservationTodo) {
        switch todo.action {
        case "assign":
            if let id = todo.assignId { run { _ = await controller.reservationAction(id, "assign") } }
        case "remove":
            if let id = todo.removeId { run { _ = await controller.reservationAction(id, "remove") } }
        default:
            if let out = todo.removeId, let into = todo.assignId {
                confirm = Confirm(text: tr("管理画面で入れ替えましたか？"), label: tr("入れ替えた"),
                                  run: { _ = await controller.swapReservations(pool.id, removeId: out, assignId: into) })
            }
        }
    }
}

/// A primitive button style chosen at run time (bordered for an upcoming to-do, prominent for a due one).
struct AnyPrimitiveButtonStyle: PrimitiveButtonStyle {
    private let make: (Configuration) -> AnyView
    init<S: PrimitiveButtonStyle>(_ style: S) { make = { AnyView(style.makeBody(configuration: $0)) } }
    func makeBody(configuration: Configuration) -> some View { make(configuration) }
}

/// 「予約する」: a day, a start on the hour (full hours marked) and how long.
struct BookingSheet: View {
    @Bindable var controller: AppController
    let pool: PoolOut
    let initialDay: Date
    @Environment(\.dismiss) private var dismiss
    @State private var day: Date?
    @State private var start: Date?
    @State private var hours = 1
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        let now = Date()
        let chosenDay = day ?? initialDay
        let starts = ReservationRules.starts(pool, day: chosenDay, now: now)
        let firstFree = starts.first { !$0.full }?.start
        let chosenStart = start.flatMap { s in starts.contains { $0.start == s && !$0.full } ? s : nil } ?? firstFree
        let durations = chosenStart.map { ReservationRules.durations(pool, start: $0, now: now) } ?? []
        let chosenHours = durations.contains(hours) ? hours : (durations.last ?? 1)
        NavigationStack {
            Form {
                Picker("日付", selection: Binding(get: { chosenDay }, set: { day = $0; start = nil })) {
                    ForEach(ReservationRules.bookingDays(now: now, horizonDays: pool.horizonDays), id: \.self) { d in
                        Text(ReservationRules.dayLabel(d, now: now)).tag(d)
                    }
                }
                if starts.allSatisfy(\.full) {
                    Text("この日は空いている時間がありません").foregroundStyle(.secondary)
                } else {
                    Picker("開始", selection: Binding(get: { chosenStart ?? now }, set: { start = $0 })) {
                        ForEach(starts) { choice in
                            Text(ReservationRules.hm(choice.start) + (choice.full ? tr(" (満)") : "")).tag(choice.start)
                                .selectionDisabled(choice.full)
                        }
                    }
                    Picker("時間", selection: Binding(get: { chosenHours }, set: { hours = $0 })) {
                        ForEach(durations, id: \.self) { h in Text("\(h) 時間").tag(h) }
                    }
                }
                if let error { Text(error).foregroundStyle(.red).font(.footnote) }
            }
            .navigationTitle("\(pool.name) を予約")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("キャンセル") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("予約する") {
                        guard let chosenStart else { return }
                        busy = true
                        Task {
                            let out = await controller.bookReservation(pool.id, startAt: chosenStart, hours: chosenHours)
                            busy = false
                            if out != nil { dismiss() } else { error = controller.error ?? tr("予約できませんでした") }
                        }
                    }
                    .disabled(busy || chosenStart == nil || durations.isEmpty)
                }
            }
        }
    }
}
