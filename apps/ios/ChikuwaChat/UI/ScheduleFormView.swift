import SwiftUI

/// What the scheduling form starts with: `/日程 題名 10/3 10/5 13:00` fills it in (M54); the ＋ menu and `/日程` alone
/// open it empty.
struct ScheduleFormInitial: Identifiable, Equatable {
    var question = ""
    var slots: [SchedulePoll.SlotDraft] = []
    let id = UUID()

    /// What `/日程 …` opens: alone, the empty form; `/日程 ゼミ 10/3 10/4 13:00-14:30` the title and candidates (a time
    /// without an end lasts an hour, a date without a time is all day); nil when the words cannot be read (the composer
    /// then shows the usage and keeps the text).
    static func reading(_ args: String, today: Templates.Day) -> ScheduleFormInitial? {
        if args.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return ScheduleFormInitial() }
        guard let read = Templates.readSchedule(args, today: today) else { return nil }
        return ScheduleFormInitial(question: read.question, slots: SchedulePoll.slots(from: read.entries))
    }
}

/// 「日程調整を作成」 (M54, SCHEDULING.md §5; the web's ScheduleDialog), full screen: a title, the days picked on a month
/// calendar (Sunday first; days before today greyed out), one time (start and length) or 終日 for all of them, then the
/// candidates listed — each one's time can change, it can be removed, and another time on the same day added — and
/// whether it is anonymous. Sent as a scheduling poll with the device's zone (the server writes the labels in it).
struct ScheduleFormView: View {
    let controller: AppController
    let channelId: String
    let parentId: String?
    private let today: DayKey
    @Environment(\.dismiss) private var dismiss
    @State private var question: String
    @State private var slots: [SchedulePoll.SlotDraft]
    @State private var month: DayKey
    @State private var allDay: Bool
    @State private var start: Int
    @State private var minutes: Int
    @State private var anonymous = false
    @State private var busy = false
    @State private var tried = false
    @State private var error: String?

    init(controller: AppController, channelId: String, parentId: String?, initial: ScheduleFormInitial = ScheduleFormInitial(), now: Date = Date()) {
        self.controller = controller
        self.channelId = channelId
        self.parentId = parentId
        let today = CalendarDates.today(now)
        self.today = today
        let slots = SchedulePoll.sortSlots(initial.slots)
        _question = State(initialValue: initial.question)
        _slots = State(initialValue: slots)
        let first = slots.first?.day
        _month = State(initialValue: CalendarDates.addMonths(first.map { $0 > today ? $0 : today } ?? today, 0))
        _allDay = State(initialValue: !slots.isEmpty && slots.allSatisfy(\.allDay))
        let timed = slots.first { !$0.allDay }
        _start = State(initialValue: timed?.start ?? SchedulePoll.defaultStart)
        _minutes = State(initialValue: timed?.minutes ?? SchedulePoll.defaultMinutes)
    }

    private var problem: String? { SchedulePoll.problem(question: question, slots: slots) }

    var body: some View {
        NavigationStack {
            Form {
                Section("題名") {
                    TextField("例: M2 中間発表の練習", text: $question, axis: .vertical)
                        .onChange(of: question) { _, value in
                            if value.count > SchedulePoll.maxQuestion { question = String(value.prefix(SchedulePoll.maxQuestion)) }
                        }
                }
                Section {
                    monthCalendar
                } header: {
                    Text("候補の日")
                } footer: {
                    Text("日を押すと候補に入ります (もう一度押すと外れます)。")
                }
                Section("時刻 (すべての候補)") {
                    Picker("時刻か終日か", selection: Binding(get: { allDay }, set: { value in
                        allDay = value
                        slots = SchedulePoll.applyToAll(slots, allDay: value)
                    })) {
                        Text("時刻を決める").tag(false)
                        Text("終日").tag(true)
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                    if !allDay {
                        DatePicker("開始時刻", selection: timeBinding(get: { start }, set: { value in
                            start = value
                            slots = SchedulePoll.applyToAll(slots, start: value)
                        }), displayedComponents: .hourAndMinute)
                        Picker("長さ", selection: Binding(get: { minutes }, set: { value in
                            minutes = value
                            slots = SchedulePoll.applyToAll(slots, minutes: value)
                        })) {
                            ForEach(SchedulePoll.lengthChoices(minutes), id: \.self) { Text(SchedulePoll.durationLabel($0)).tag($0) }
                        }
                    }
                }
                Section {
                    if slots.isEmpty {
                        Text("カレンダーで日を選んでください").font(.subheadline).foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, alignment: .center)
                    }
                    ForEach(Array(slots.enumerated()), id: \.offset) { index, slot in
                        slotRow(index, slot)
                    }
                } header: {
                    HStack {
                        Text("候補")
                        Spacer()
                        Text("\(slots.count) / \(SchedulePoll.maxSlots)")
                            .foregroundStyle(slots.count > SchedulePoll.maxSlots ? Color.red : Color.secondary)
                    }
                }
                Section {
                    Toggle(isOn: $anonymous) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("匿名にする")
                            Text("誰が答えたかを表示しません").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
                if let message = error ?? (tried ? problem : nil) {
                    Text(message).font(.footnote).foregroundStyle(.red)
                }
            }
            .environment(\.timeZone, CalendarDates.zone)
            .environment(\.locale, UILanguage.shared.locale)
            .navigationTitle("日程調整を作成")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("キャンセル") { dismiss() }.disabled(busy) }
                ToolbarItem(placement: .confirmationAction) { Button(busy ? "作成中…" : "作成", action: create).disabled(busy) }
            }
        }
        .interactiveDismissDisabled(busy)
    }

    // MARK: the month

    private var monthCalendar: some View {
        let picked = Set(slots.map(\.day))
        return VStack(spacing: 6) {
            HStack {
                Button { month = CalendarDates.addMonths(month, -1) } label: { Image(systemName: "chevron.left").frame(width: 36, height: 32) }
                    .accessibilityLabel("前の月")
                Spacer()
                Text(CalendarDates.monthLabel(month)).font(.subheadline.weight(.semibold))
                Spacer()
                Button { month = CalendarDates.addMonths(month, 1) } label: { Image(systemName: "chevron.right").frame(width: 36, height: 32) }
                    .accessibilityLabel("次の月")
            }
            .buttonStyle(.borderless)
            Grid(horizontalSpacing: 2, verticalSpacing: 2) {
                GridRow {
                    ForEach(0..<7, id: \.self) { index in
                        Text(CalendarDates.weekdays[index]).font(.caption2)
                            .foregroundStyle(index == 0 ? Color.red : index == 6 ? Color.accentColor : Color.secondary)
                            .frame(maxWidth: .infinity)
                    }
                }
                ForEach(CalendarDates.monthGrid(month), id: \.self) { week in
                    GridRow {
                        ForEach(week, id: \.self) { day in dayCell(day, chosen: picked.contains(day)) }
                    }
                }
            }
        }
        .padding(.vertical, 2)
    }

    private func dayCell(_ day: DayKey, chosen: Bool) -> some View {
        let inMonth = CalendarDates.sameMonth(day, month)
        let past = day < today
        return Button {
            slots = SchedulePoll.toggle(day, in: slots, allDay: allDay, start: start, minutes: minutes)
        } label: {
            Text("\(CalendarDates.dayOfMonth(day))")
                .font(.subheadline.weight(chosen ? .semibold : .regular))
                .monospacedDigit()
                .foregroundStyle(chosen ? Color.white : inMonth ? Color.primary : Color.secondary.opacity(0.6))
                .frame(maxWidth: .infinity, minHeight: 36)
                .background {
                    if chosen {
                        RoundedRectangle(cornerRadius: 8).fill(Color.accentColor)
                    } else if day == today {
                        RoundedRectangle(cornerRadius: 8).stroke(Color.accentColor.opacity(0.6))
                    }
                }
                .contentShape(Rectangle())
        }
        .buttonStyle(.borderless)
        .disabled(past && !chosen)
        .opacity(past && !chosen ? 0.35 : 1)
        .accessibilityLabel(CalendarDates.dayLabel(day))
        .accessibilityAddTraits(chosen ? .isSelected : [])
    }

    // MARK: the candidates

    private func slotRow(_ index: Int, _ slot: SchedulePoll.SlotDraft) -> some View {
        let label = SchedulePoll.slotLabel(slot)
        return VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(label).font(.subheadline)
                Spacer()
                Button { slots.remove(at: index) } label: {
                    Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary).font(.title3)
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("\(label) を削除")
            }
            if !slot.allDay {
                HStack(spacing: 8) {
                    DatePicker("\(label) の開始時刻", selection: timeBinding(get: { slot.start }, set: { value in change(index) { $0.start = value } }),
                               displayedComponents: .hourAndMinute)
                        .labelsHidden()
                    Picker("\(label) の長さ", selection: Binding(get: { slot.minutes }, set: { value in change(index) { $0.minutes = value } })) {
                        ForEach(SchedulePoll.lengthChoices(slot.minutes), id: \.self) { Text(SchedulePoll.durationLabel($0)).tag($0) }
                    }
                    .labelsHidden()
                    .pickerStyle(.menu)
                    Spacer()
                    Button { slots = SchedulePoll.addAfter(index, in: slots) } label: {
                        Image(systemName: "plus.square.on.square").font(.body)
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("\(label) の後に同じ日の候補を追加")
                }
            }
        }
        .padding(.vertical, 2)
    }

    private func change(_ index: Int, _ update: (inout SchedulePoll.SlotDraft) -> Void) {
        guard slots.indices.contains(index) else { return }
        update(&slots[index])
    }

    /// A time of day (minutes since midnight) as the picker's date, today in the device's zone.
    private func timeBinding(get: @escaping () -> Int, set: @escaping (Int) -> Void) -> Binding<Date> {
        Binding(get: {
            let value = get()
            return CalendarDates.at(today, hour: value / 60, minute: value % 60)
        }, set: { date in
            let parts = CalendarDates.local.dateComponents([.hour, .minute], from: date)
            set((parts.hour ?? 0) * 60 + (parts.minute ?? 0))
        })
    }

    private func create() {
        tried = true
        error = nil
        guard problem == nil, !busy else { return }
        busy = true
        let title = question.trimmingCharacters(in: .whitespacesAndNewlines)
        let body = SchedulePoll.sortSlots(slots).map(SchedulePoll.slotIn)
        Task {
            let made = await controller.createSchedulePoll(channelId: channelId, parentId: parentId, question: title, slots: body,
                                                           anonymous: anonymous)
            busy = false
            if made {
                dismiss()
            } else {
                // Said here: the toast is under this cover.
                error = controller.error ?? ErrorMessages.unknown
                controller.error = nil
            }
        }
    }
}
