import SwiftUI

/// M52 (CALENDAR.md §7): an event's full-screen form, as the web's dialog. New: 題名, 終日, 開始 / 終了 (the device's zone;
/// timed events go out as UTC instants, all-day ones as dates), カレンダー (自分 or a channel I may post in; fixed once
/// made), 場所, 説明 and my 通知. Someone who may not change the event (can_edit false) reads it, with only their own
/// alarm to set. Deleting asks first.
///
/// M69 (CALENDAR.md §10.7, §10.9): 「繰り返し」 (RepeatPickerSection) and, on an occurrence of a recurring event, saving or
/// deleting asks which ones (「この予定」「これ以降すべて」「すべての予定」; 「この予定」 only when the change fits one
/// occurrence: not its rule, not all-day ↔ timed). Only what the form changed is sent (§10.8). My alarm is the series'.
struct CalendarEventForm: View {
    @Bindable var controller: AppController
    let hub: CalendarHub?
    /// The event opened; nil: a new one.
    let event: CalendarEventOut?
    @State private var draft: EventDraft
    @State private var busy = false
    @State private var error: String?
    @State private var confirmDelete = false
    /// M69: the scope dialog of a recurring event's occurrence.
    @State private var askScope: ScopeAsk?
    /// The creation's idempotency key: a retry after a failure never makes a second event (§4).
    @State private var clientEventId = UUID().uuidString.lowercased()
    @Environment(\.dismiss) private var dismiss
    /// The event as opened (what 「変えた項目」 are measured against).
    private let opened: EventDraft?

    /// What the scope dialog asks about.
    struct ScopeAsk: Equatable {
        enum Action { case save, delete }
        let action: Action
        let allowThis: Bool

        var title: String { action == .delete ? "繰り返しの予定の削除" : "繰り返しの予定の変更" }
        var scopes: [OccurrenceScope] { OccurrenceScope.allCases.filter { allowThis || $0 != .this } }
    }

    init(controller: AppController, hub: CalendarHub?, target: CalendarFormTarget) {
        self.controller = controller
        self.hub = hub
        switch target {
        case .new(let initial):
            event = nil
            opened = nil
            _draft = State(initialValue: initial)
        case .event(let event):
            self.event = event
            opened = EventDraft(event: event)
            _draft = State(initialValue: EventDraft(event: event))
        }
    }

    private var recurring: Bool { event?.recurring ?? false }

    private var editable: Bool { event?.canEdit ?? true }
    private var alarmChanged: Bool { event?.alarm?.minutesBefore != draft.alarm }
    private var problem: String? { editable ? draft.problem : nil }
    private var canSave: Bool { hub != nil && !busy && problem == nil && (editable || alarmChanged) }

    private var title: String {
        guard event != nil else { return "予定を追加" }
        return editable ? "予定を編集" : "予定"
    }

    var body: some View {
        NavigationStack {
            Form {
                if editable {
                    editableFields
                } else if let event {
                    readOnly(event)
                }
                Section {
                    Picker("通知", selection: $draft.alarm) {
                        ForEach(CalendarDates.alarmChoices(allDay: draft.allDay), id: \.self) { choice in
                            Text(choice.label).tag(choice.value)
                        }
                    }
                } footer: {
                    if draft.channelId != nil { Text("通知は自分にだけ届きます") }
                }
                if let error {
                    Section { Text(error).foregroundStyle(.red).font(.footnote) }
                }
                if event != nil && editable {
                    Section {
                        Button("予定を削除", role: .destructive) {
                            if recurring { askScope = ScopeAsk(action: .delete, allowThis: true) } else { confirmDelete = true }
                        }
                            .frame(maxWidth: .infinity)
                            .disabled(busy)
                    }
                }
            }
            .environment(\.timeZone, CalendarDates.zone)
            .environment(\.locale, Locale(identifier: "ja_JP")) // the pickers say 2026年10月1日, as the rest of the form
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(editable || alarmChanged ? "キャンセル" : "閉じる") { dismiss() }
                }
                if editable || alarmChanged {
                    ToolbarItem(placement: .confirmationAction) {
                        Button(event == nil ? "追加" : "保存") { Task { await save() } }
                            .disabled(!canSave)
                    }
                }
            }
            .confirmationDialog("この予定を削除しますか？", isPresented: $confirmDelete, titleVisibility: .visible) {
                Button("削除する", role: .destructive) { Task { await remove() } }
                Button("キャンセル", role: .cancel) {}
            }
            .confirmationDialog(askScope?.title ?? "", isPresented: Binding(get: { askScope != nil }, set: { if !$0 { askScope = nil } }),
                                titleVisibility: .visible, presenting: askScope) { ask in
                ForEach(ask.scopes) { scope in
                    Button(scope.label, role: ask.action == .delete ? .destructive : nil) { Task { await apply(scope, ask) } }
                }
                Button("キャンセル", role: .cancel) {}
            }
            .interactiveDismissDisabled(busy)
        }
    }

    @ViewBuilder
    private var editableFields: some View {
        Section {
            TextField("題名", text: $draft.title)
        }
        Section {
            Toggle("終日", isOn: Binding(get: { draft.allDay }, set: { draft = draft.settingAllDay($0); error = nil }))
            DatePicker("開始", selection: Binding(get: { draft.start }, set: { draft = draft.movingStart(to: $0); error = nil }),
                       displayedComponents: draft.allDay ? [.date] : [.date, .hourAndMinute])
            DatePicker("終了", selection: Binding(get: { draft.end }, set: { draft.end = $0; error = nil }),
                       displayedComponents: draft.allDay ? [.date] : [.date, .hourAndMinute])
        } footer: {
            // An empty title only greys out 追加; a time that cannot be says why.
            if let problem, problem != "題名を入れてください" { Text(problem).foregroundStyle(.red) }
        }
        RepeatPickerSection(repetition: Binding(get: { draft.repetition }, set: { draft.repetition = $0; error = nil }), start: draft.startDay)
        Section {
            Picker("カレンダー", selection: $draft.channelId) {
                Text("自分 (自分だけに表示)").tag(String?.none)
                if let channelId = event?.channelId, !controller.writableCalendars.contains(where: { $0.id == channelId }) {
                    Text(calendarName(channelId)).tag(String?.some(channelId))
                }
                ForEach(controller.writableCalendars) { channel in
                    Text("#" + (channel.channel.name ?? "")).tag(String?.some(channel.id))
                }
            }
            .disabled(event != nil)
        } footer: {
            if event != nil { Text("予定のカレンダーはあとから変えられません。") }
        }
        Section {
            TextField("場所 (5 号館 501 / https://…)", text: $draft.location)
            TextField("説明", text: $draft.description, axis: .vertical)
                .lineLimit(3...10)
        }
    }

    private func calendarName(_ channelId: String?) -> String {
        guard let channelId else { return "自分" }
        return "#" + (controller.store.channel(channelId)?.channel.name ?? event?.channelName ?? "?")
    }

    /// What someone who may not change the event sees of it.
    private func readOnly(_ event: CalendarEventOut) -> some View {
        Section {
            HStack(alignment: .top, spacing: 10) {
                RoundedRectangle(cornerRadius: 3).fill(CalendarDates.color(event.channelId)).frame(width: 12, height: 12).padding(.top, 5)
                VStack(alignment: .leading, spacing: 3) {
                    Text(event.title).font(.headline)
                    Text(CalendarDates.eventWhen(event)).font(.subheadline).foregroundStyle(.secondary)
                    Text(calendarName(event.channelId)).font(.caption).foregroundStyle(.secondary)
                    if event.recurring {
                        RecurrenceLine(event: event).font(.caption)
                    }
                }
            }
            if let location = event.location {
                Label(location, systemImage: "mappin.and.ellipse").font(.subheadline).textSelection(.enabled)
            }
            if let description = event.description {
                Text(description).font(.subheadline).textSelection(.enabled)
            }
        } footer: {
            Text("この予定を変更できるのは、作成者・チャンネルのオーナー・管理者です。")
        }
    }

    private func save() async {
        guard let hub, canSave else { return }
        busy = true
        defer { busy = false }
        if let event, let opened, recurring, editable {
            let rule = CalendarRecurrence.ruleChanged(draft.repetition, start: draft.startDay, rrule: event.rrule)
            if !draft.changes(from: opened).isEmpty || rule {
                askScope = ScopeAsk(action: .save, allowThis: !rule && draft.allDay == event.allDay)
                return
            }
        }
        do {
            if let event {
                if editable && !recurring {
                    var patch = draft.patch
                    if let rrule = draft.rrule {
                        // A one-off event made recurring: it repeats in the device's zone.
                        patch.rrule = rrule
                        patch.tz = CalendarDates.zoneId
                    }
                    _ = try await hub.update(event.id, patch)
                }
                // The server remaps the alarm when the event turns all-day (or back); what was chosen here wins.
                if alarmChanged || (editable && !recurring && draft.allDay != event.allDay && draft.alarm != nil) {
                    try await hub.setAlarm(event.series, minutes: draft.alarm)
                }
            } else {
                _ = try await hub.create(draft.create(tz: CalendarDates.zoneId, clientEventId: clientEventId))
            }
            dismiss()
        } catch {
            self.error = controller.describe(error)
        }
    }

    /// M69: what a recurring event's occurrence sends for the scope chosen (only what changed; the rule for 「これ以降」 /
    /// 「すべて」 when it changed, null when it no longer repeats).
    static func occurrenceUpdate(_ scope: OccurrenceScope, draft: EventDraft, opened: EventDraft, rrule: String?) -> CalendarOccurrenceUpdate {
        var body = CalendarOccurrenceUpdate(scope: scope, changes: draft.changes(from: opened))
        if scope != .this && CalendarRecurrence.ruleChanged(draft.repetition, start: draft.startDay, rrule: rrule) {
            body.changes["rrule"] = draft.rrule.map(JSONValue.string) ?? .null
        }
        return body
    }

    /// A recurring event's occurrence saved or deleted, for the occurrences chosen.
    private func apply(_ scope: OccurrenceScope, _ ask: ScopeAsk) async {
        guard let hub, let event, let opened, !busy else { return }
        busy = true
        defer { busy = false }
        do {
            switch ask.action {
            case .delete:
                try await hub.removeOccurrence(event.series, occurrenceStart: event.occurrenceKey, scope: scope)
            case .save:
                let body = Self.occurrenceUpdate(scope, draft: draft, opened: opened, rrule: event.rrule)
                let result = try await hub.updateOccurrence(event.series, occurrenceStart: event.occurrenceKey, body)
                // 「これ以降」 makes a new series: the alarm goes to the one answered.
                if alarmChanged { try await hub.setAlarm(result.series, minutes: draft.alarm) }
            }
            dismiss()
        } catch {
            self.error = controller.describe(error)
        }
    }

    private func remove() async {
        guard let hub, let event else { return }
        busy = true
        defer { busy = false }
        do {
            try await hub.remove(event.id)
            dismiss()
        } catch {
            self.error = controller.describe(error)
        }
    }
}

/// M69: a recurring event's rule in words, after 🔁 (「毎週 火曜日」), read on the occurrence's day.
struct RecurrenceLine: View {
    let event: CalendarEventOut

    var body: some View {
        Label(CalendarRecurrence.describe(event.rrule, start: CalendarDates.eventDays(event).first), systemImage: "repeat")
            .foregroundStyle(.secondary)
            .accessibilityLabel("繰り返し: " + CalendarRecurrence.describe(event.rrule, start: CalendarDates.eventDays(event).first))
    }
}

/// M69 (CALENDAR.md §10.7): 「繰り返し」 — しない / 毎日 / 毎週 (曜日) / 毎月 (日付・月末・第 N 曜日・最終 X 曜日) / 毎年 /
/// カスタム (間隔), the end (なし / 日付 / 回数) whenever it repeats, and the rule in words below.
struct RepeatPickerSection: View {
    @Binding var repetition: RepeatDraft
    let start: DayKey
    /// M84: a line under the rule while it repeats (a task's 「完了にすると、次の回のタスクができます」).
    var note: String? = nil

    private var rrule: String? { CalendarRecurrence.toRrule(repetition, start: start) }

    var body: some View {
        Section {
            Picker("繰り返し", selection: Binding(get: { repetition.kind }, set: choose)) {
                ForEach(RepeatKind.allCases, id: \.self) { Text($0.label).tag($0) }
            }
            if repetition.kind == .custom {
                Stepper(value: $repetition.interval, in: 1...CalendarRecurrence.maxInterval) {
                    HStack {
                        Text("間隔")
                        Spacer()
                        Text("\(repetition.interval)").monospacedDigit()
                        Picker("単位", selection: $repetition.freq) {
                            ForEach(RepeatFreq.allCases, id: \.self) { Text($0.unit).tag($0) }
                        }
                        .labelsHidden()
                        .fixedSize()
                        Text("ごと")
                    }
                }
            }
            if repetition.frequency == .weekly {
                WeekdayToggles(weekdays: $repetition.weekdays)
            }
            if repetition.frequency == .monthly {
                let choices = CalendarRecurrence.monthlyChoices(start)
                Picker("毎月の日", selection: $repetition.monthly) {
                    ForEach(choices, id: \.self) { Text($0.label).tag($0.value) }
                    if !choices.contains(where: { $0.value == repetition.monthly }) {
                        Text(CalendarRecurrence.describe(rrule, start: start)).tag(repetition.monthly)
                    }
                }
            }
            if repetition.kind != .none {
                Picker("終了", selection: Binding(get: { repetition.end }, set: chooseEnd)) {
                    ForEach(RepeatEnd.allCases, id: \.self) { Text($0.label).tag($0) }
                }
                if repetition.end == .until {
                    DatePicker("終了日", selection: Binding(get: { CalendarDates.parseDay(repetition.until.isEmpty ? start : repetition.until) },
                                                         set: { repetition.until = CalendarDates.dayKey($0) }),
                               in: CalendarDates.parseDay(start)..., displayedComponents: [.date])
                }
                if repetition.end == .count {
                    Stepper(value: $repetition.count, in: 1...CalendarRecurrence.maxCount) {
                        HStack {
                            Text("回数")
                            Spacer()
                            TextField("回数", value: $repetition.count, format: .number)
                                .keyboardType(.numberPad)
                                .multilineTextAlignment(.trailing)
                                .frame(maxWidth: 64)
                            Text("回")
                        }
                    }
                }
            }
        } footer: {
            if let problem = CalendarRecurrence.problem(repetition, start: start) {
                Text(problem).foregroundStyle(.red)
            } else if let rrule {
                VStack(alignment: .leading, spacing: 4) {
                    Label(CalendarRecurrence.describe(rrule, start: start), systemImage: "repeat")
                    if let note { Text(note) }
                }
            }
        }
    }

    /// A kind chosen: カスタム starts from the preset it came from; 毎週 from しない starts with the start's weekday.
    private func choose(_ kind: RepeatKind) {
        var next = repetition
        if kind == .custom && repetition.kind != .custom { next.freq = repetition.frequency ?? .weekly }
        if repetition.kind == .none { next.weekdays = [CalendarDates.weekday(start)] }
        next.kind = kind
        repetition = next
    }

    /// 日付 starts a month after the start.
    private func chooseEnd(_ end: RepeatEnd) {
        repetition.end = end
        if end == .until && repetition.until.isEmpty { repetition.until = CalendarDates.addDays(CalendarDates.addMonths(start, 1), CalendarDates.dayOfMonth(start) - 1) }
    }
}

/// 毎週's days, 日 to 土, each a round toggle.
private struct WeekdayToggles: View {
    @Binding var weekdays: [Int]

    var body: some View {
        HStack(spacing: 6) {
            ForEach(0..<7, id: \.self) { day in
                let on = weekdays.contains(day)
                Button {
                    weekdays = on ? weekdays.filter { $0 != day } : weekdays + [day]
                } label: {
                    Text(CalendarDates.weekdays[day])
                        .font(.footnote.weight(.medium))
                        .frame(maxWidth: .infinity, minHeight: 34)
                        .foregroundStyle(on ? Color.white : (CalendarMonthGrid.weekdayColor(day) ?? .primary))
                        .background(Circle().fill(on ? Color.accentColor : Color.secondary.opacity(0.12)))
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("\(CalendarDates.weekdays[day])曜日")
                .accessibilityAddTraits(on ? [.isSelected] : [])
            }
        }
        .padding(.vertical, 2)
    }
}
