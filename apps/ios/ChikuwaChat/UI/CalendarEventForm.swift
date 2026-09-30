import SwiftUI

/// M52 (CALENDAR.md §7): an event's full-screen form, as the web's dialog. New: 題名, 終日, 開始 / 終了 (the device's zone;
/// timed events go out as UTC instants, all-day ones as dates), カレンダー (自分 or a channel I may post in; fixed once
/// made), 場所, 説明 and my 通知. Someone who may not change the event (can_edit false) reads it, with only their own
/// alarm to set. Deleting asks first.
struct CalendarEventForm: View {
    @Bindable var controller: AppController
    let hub: CalendarHub?
    /// The event opened; nil: a new one.
    let event: CalendarEventOut?
    @State private var draft: EventDraft
    @State private var busy = false
    @State private var error: String?
    @State private var confirmDelete = false
    /// The creation's idempotency key: a retry after a failure never makes a second event (§4).
    @State private var clientEventId = UUID().uuidString.lowercased()
    @Environment(\.dismiss) private var dismiss

    init(controller: AppController, hub: CalendarHub?, target: CalendarFormTarget) {
        self.controller = controller
        self.hub = hub
        switch target {
        case .new(let initial):
            event = nil
            _draft = State(initialValue: initial)
        case .event(let event):
            self.event = event
            _draft = State(initialValue: EventDraft(event: event))
        }
    }

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
                        Button("予定を削除", role: .destructive) { confirmDelete = true }
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
        do {
            if let event {
                if editable { _ = try await hub.update(event.id, draft.patch) }
                // The server remaps the alarm when the event turns all-day (or back); what was chosen here wins.
                if alarmChanged || (editable && draft.allDay != event.allDay && draft.alarm != nil) {
                    try await hub.setAlarm(event.id, minutes: draft.alarm)
                }
            } else {
                _ = try await hub.create(draft.create(tz: CalendarDates.zoneId, clientEventId: clientEventId))
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
