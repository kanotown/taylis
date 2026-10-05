import SwiftUI

/// M95 (docs/WORKFLOWS.md §8): the phone's workflows — the list a channel offers (the composer's 「＋」 and the channel
/// details), the full-screen form that posts the message, and the 「⚡ name」 label above a message one posted. Phones run
/// workflows only; making, editing, stopping and resuming them is the desktop's and the web's (§8 5.).

/// Above a message a workflow posted: 「⚡ name」, a fixed one-line height (the row does not change once drawn). A tap
/// opens the workflow's form when I can still use it, else says why.
struct WorkflowLabel: View {
    let name: String
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            HStack(spacing: 3) {
                Image(systemName: "bolt.fill").foregroundStyle(.orange)
                Text(name).lineLimit(1)
            }
            .font(.caption2.weight(.medium))
            .foregroundStyle(.secondary)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("ワークフロー \(name)")
        .accessibilityHint("このワークフローを使う")
    }
}

/// One workflow of the list: its mark, name, description, where it posts when elsewhere, and why it cannot run (grey).
struct WorkflowRow: View {
    let workflow: WorkflowOut
    /// The conversation the list belongs to.
    let here: String
    let target: String

    var body: some View {
        let blocked = Workflows.runBlockedText(workflow, target: target)
        HStack(alignment: .top, spacing: 10) {
            Text(workflow.mark).font(.title3).frame(width: 28)
            VStack(alignment: .leading, spacing: 2) {
                Text(workflow.name).font(.body.weight(.medium)).foregroundStyle(Color.primary)
                if !workflow.description.isEmpty {
                    Text(workflow.description).font(.footnote).foregroundStyle(.secondary).lineLimit(2)
                }
                if workflow.channelId != here {
                    Text("→ \(target) に投稿").font(.footnote).foregroundStyle(.secondary)
                }
                if let blocked {
                    Text(blocked).font(.footnote).foregroundStyle(.orange)
                }
            }
            Spacer(minLength: 0)
        }
        .opacity(blocked == nil ? 1 : 0.5)
        .contentShape(Rectangle())
    }
}

/// The workflows a channel offers, read each time the list opens (kept a minute). `onPick` gets one I can run.
struct WorkflowListView: View {
    @Bindable var controller: AppController
    let channelId: String
    let onPick: (WorkflowOut) -> Void

    enum Rows: Equatable { case loading, failed, ready([WorkflowOut]) }
    @State private var rows: Rows = .loading

    var body: some View {
        List {
            switch rows {
            case .loading:
                HStack(spacing: 8) { ProgressView(); Text("読み込み中…").foregroundStyle(.secondary) }
            case .failed:
                Text("読み込めませんでした").foregroundStyle(.red)
            case .ready(let list):
                if list.isEmpty {
                    Text("このチャンネルにはワークフローがありません").foregroundStyle(.secondary)
                } else {
                    Section {
                        ForEach(list) { workflow in
                            let blocked = Workflows.runBlockedText(workflow, target: controller.workflowTarget(workflow.channelId)) != nil
                            Button { onPick(workflow) } label: {
                                WorkflowRow(workflow: workflow, here: channelId, target: controller.workflowTarget(workflow.channelId))
                            }
                            .buttonStyle(.plain)
                            .disabled(blocked)
                        }
                    } footer: {
                        Text("フォームに入力すると、決まった形のメッセージを投稿します。作成・編集はデスクトップ版・Web 版で行います。")
                    }
                }
            }
        }
        .navigationTitle("ワークフロー")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: channelId) {
            guard let list = await controller.channelWorkflows(channelId) else { rows = .failed; return }
            rows = .ready(list)
        }
    }
}

/// The composer's 「＋」 → 「ワークフロー」: the list in a sheet; the form opens once the sheet has gone.
struct WorkflowListSheet: View {
    @Bindable var controller: AppController
    let channelId: String
    @Binding var picked: WorkflowOut?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            WorkflowListView(controller: controller, channelId: channelId) { workflow in
                picked = workflow
                dismiss()
            }
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("閉じる") { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
    }
}

/// The form (full screen): one control per field with its default from the device's date, required marks and help, the
/// preview under it, per-field errors, and 投稿 with one idempotency key kept until the form closes.
struct WorkflowFormView: View {
    @Bindable var controller: AppController
    let target: WorkflowRunTarget
    /// Tests pass a fake; the app uses the controller's client.
    var api: WorkflowApi?

    @Environment(\.dismiss) private var dismiss
    @State private var values: [String: Workflows.Value]
    @State private var errors: [String: String] = [:]
    @State private var problem: String?
    @State private var busy = false
    @State private var submitter: WorkflowSubmitter?

    init(controller: AppController, target: WorkflowRunTarget, api: WorkflowApi? = nil) {
        self.controller = controller
        self.target = target
        self.api = api
        _values = State(initialValue: Workflows.initialValues(target.workflow.fields, today: .today(), me: controller.store.me?.id))
    }

    private var workflow: WorkflowOut { target.workflow }
    private var targetName: String { controller.workflowTarget(workflow.channelId) }
    private var preview: String { Workflows.preview(workflow.template, fields: workflow.fields, values: values) }
    private var people: [String] {
        controller.store.users.values.filter { $0.role != "bot" && $0.deactivatedAt == nil }.map(\.id)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text(workflow.description.isEmpty ? tr("\(targetName) に投稿します") : workflow.description)
                        .font(.subheadline).foregroundStyle(.secondary)
                }
                ForEach(workflow.fields) { field in
                    Section {
                        control(field)
                        if !field.help.isEmpty { Text(field.help).font(.footnote).foregroundStyle(.secondary) }
                        if let error = errors[field.key] {
                            Text(Workflows.errorText(error)).font(.footnote).foregroundStyle(.red)
                        }
                    } header: {
                        if field.type != "checkbox" { title(field) }
                    }
                }
                Section {
                    if preview.isEmpty {
                        Text("(空です)").foregroundStyle(.secondary)
                    } else {
                        MessageBodyView(text: preview, users: controller.store.users, groups: controller.store.groups,
                                        customEmoji: controller.store.customEmoji, emojiImages: controller.store.emojiImages,
                                        emojiAnimations: controller.store.emojiAnimations, onNeedEmojiImage: { controller.loadEmojiImage($0) })
                    }
                } header: {
                    Text("プレビュー (\(targetName) に、あなたの投稿として)")
                }
                if let problem {
                    Section { Text(problem).foregroundStyle(.red) }
                }
            }
            .navigationTitle("\(workflow.mark) \(workflow.name)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("キャンセル") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if busy { ProgressView() } else { Button("投稿") { submit() }.disabled(!workflow.canRun) }
                }
            }
            .interactiveDismissDisabled(busy)
        }
    }

    private func title(_ field: WorkflowField) -> Text {
        Text(field.label) + (field.required ? Text(" *").foregroundColor(.red) : Text(""))
    }

    private func binding(_ field: WorkflowField) -> Binding<Workflows.Value> {
        Binding(get: { values[field.key] ?? Workflows.emptyValue(field) }, set: { value in
            values[field.key] = value
            errors[field.key] = nil
            problem = nil
        })
    }

    private func textBinding(_ field: WorkflowField) -> Binding<String> {
        let value = binding(field)
        return Binding(get: { value.wrappedValue.text }, set: { value.wrappedValue = .text($0) })
    }

    @ViewBuilder
    private func control(_ field: WorkflowField) -> some View {
        switch field.type {
        case "textarea":
            TextField(field.label, text: textBinding(field), axis: .vertical).lineLimit(3...10)
        case "date", "time", "datetime":
            WorkflowDateControl(type: field.type, required: field.required, value: textBinding(field))
        case "select":
            Picker(field.label, selection: textBinding(field)) {
                Text("選んでください").tag("")
                ForEach(field.options, id: \.self) { Text($0).tag($0) }
            }
            .pickerStyle(.menu)
        case "user":
            let value = binding(field)
            NavigationLink {
                TaskAssigneePicker(controller: controller, memberIds: people,
                                   selected: Binding(get: { value.wrappedValue.users }, set: { value.wrappedValue = .users($0) }),
                                   title: field.label, single: !field.multiple)
            } label: {
                let ids = value.wrappedValue.users
                Text(ids.isEmpty ? (field.multiple ? tr("人を選ぶ") : tr("人を選ぶ (1 人)"))
                     : ids.map { controller.store.users[$0]?.displayName ?? "?" }.joined(separator: tr("、")))
                    .foregroundStyle(ids.isEmpty ? Color.secondary : Color.primary)
                    .lineLimit(2)
            }
        case "checkbox":
            let value = binding(field)
            Toggle(isOn: Binding(get: { value.wrappedValue.flag }, set: { value.wrappedValue = .flag($0) })) { title(field) }
        default:
            TextField(field.label, text: textBinding(field))
        }
    }

    private func submit() {
        guard !busy, let client = api ?? controller.api else { return }
        let submitter = self.submitter ?? WorkflowSubmitter(api: client)
        self.submitter = submitter
        busy = true
        problem = nil
        Task {
            let outcome = await submitter.submit(workflow, values: values)
            busy = false
            switch outcome {
            case .posted(let message):
                controller.workflowPosted(message, here: target.here)
                dismiss()
            case .invalid(let fields):
                errors = fields
                problem = tr("入力を確認してください")
            case .failed(let text):
                problem = text
            }
        }
    }
}

/// A date, time or date-and-time field: the system picker; an optional field starts unset and can be cleared.
private struct WorkflowDateControl: View {
    let type: String
    let required: Bool
    @Binding var value: String

    private var components: DatePickerComponents {
        type == "date" ? .date : type == "time" ? .hourAndMinute : [.date, .hourAndMinute]
    }

    var body: some View {
        if let date = WorkflowDates.date(value, type: type) {
            HStack {
                DatePicker("", selection: Binding(get: { date }, set: { value = WorkflowDates.text($0, type: type) }),
                           displayedComponents: components)
                    .labelsHidden()
                Spacer()
                if !required {
                    Button("クリア", role: .destructive) { value = "" }.buttonStyle(.borderless).font(.footnote)
                }
            }
        } else {
            Button(type == "time" ? "時刻を選ぶ" : "日付を選ぶ") { value = WorkflowDates.text(Date(), type: type) }
        }
    }
}

/// The form's values ⇄ the pickers' dates, on the device's calendar (the values carry no time zone, §3.1).
enum WorkflowDates {
    static func date(_ value: String, type: String, calendar: Calendar = .current) -> Date? {
        var parts = DateComponents()
        switch type {
        case "date":
            guard let day = Workflows.parseDate(value) else { return nil }
            (parts.year, parts.month, parts.day, parts.hour) = (day.year, day.month, day.day, 12)
        case "time":
            guard Workflows.validTime(value) else { return nil }
            let today = Templates.Day.today(calendar: calendar)
            (parts.year, parts.month, parts.day) = (today.year, today.month, today.day)
            (parts.hour, parts.minute) = (Int(value.prefix(2)), Int(value.suffix(2)))
        default:
            guard let (dateText, time) = Workflows.parseDatetime(value), let day = Workflows.parseDate(dateText) else { return nil }
            (parts.year, parts.month, parts.day) = (day.year, day.month, day.day)
            (parts.hour, parts.minute) = (Int(time.prefix(2)), Int(time.suffix(2)))
        }
        return calendar.date(from: parts)
    }

    static func text(_ date: Date, type: String, calendar: Calendar = .current) -> String {
        let c = calendar.dateComponents([.year, .month, .day, .hour, .minute], from: date)
        let day = String(format: "%04d-%02d-%02d", c.year ?? 2000, c.month ?? 1, c.day ?? 1)
        let time = String(format: "%02d:%02d", c.hour ?? 0, c.minute ?? 0)
        return type == "date" ? day : type == "time" ? time : "\(day)T\(time)"
    }
}
