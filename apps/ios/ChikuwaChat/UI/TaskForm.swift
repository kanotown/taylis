import SwiftUI

/// M56 (TASKS.md §6, the phone column): a task's full-screen form, as the web's dialog — 題名, メモ, 状態 (the three
/// columns), 期限 (a date, or none), 担当者 (the channel's members; not for a personal task), the message it came from
/// (opens it), 削除 (who may, asked first). New tasks too (「タスクにする」, 「自分のタスク」's ＋), with where they go: a
/// channel's board or 「自分のタスク」. Someone who may not edit the board reads the task.
struct TaskForm: View {
    @Bindable var controller: AppController
    let hub: TaskHub?
    /// The task opened; nil: a new one.
    let task: TaskOut?
    /// Tests pass the channel's members (else they are read from the server).
    var memberIds: [String]?
    var today: DayKey?
    @State private var draft: TaskDraft
    @State private var busy = false
    @State private var error: String?
    @State private var confirmDelete = false
    @State private var members: [String]?
    /// The creation's idempotency key: a retry after a failure never makes a second task (SYNC_PROTOCOL.md §16).
    @State private var clientTaskId = UUID().uuidString.lowercased()
    @Environment(\.dismiss) private var dismiss

    init(controller: AppController, hub: TaskHub?, target: TaskFormTarget, memberIds: [String]? = nil, today: DayKey? = nil) {
        self.controller = controller
        self.hub = hub
        self.memberIds = memberIds
        self.today = today
        switch target {
        case .new(let initial):
            task = nil
            _draft = State(initialValue: initial)
        case .task(let task):
            self.task = task
            _draft = State(initialValue: TaskDraft(task: task))
        }
    }

    /// The task as it is now (an event may have changed it while the form is open).
    private var current: TaskOut? { task.flatMap { hub?.find($0.id) } ?? task }
    private var channelId: String? { task?.channelId ?? draft.channelId }
    private var editable: Bool { current.map(controller.canEditTask) ?? true }
    private var problem: String? { editable ? draft.problem : nil }
    private var canSave: Bool { hub?.available == true && !busy && problem == nil && editable }
    private var now: DayKey { today ?? CalendarDates.today() }

    /// The boards a new task may go to besides 「自分のタスク」 (those I may still add to).
    private var boards: [String] { draft.boardChoices.filter(controller.canEditBoard) }

    private var title: String {
        guard task != nil else { return "タスクを追加" }
        return editable ? "タスクを編集" : "タスク"
    }

    var body: some View {
        NavigationStack {
            Form {
                if task == nil {
                    Section {
                        Picker("追加先", selection: Binding(get: { draft.channelId }, set: { id in
                            draft.channelId = id
                            draft.assigneeIds = []
                        })) {
                            ForEach(boards, id: \.self) { id in Text(boardName(id)).tag(String?.some(id)) }
                            Text("自分のタスク (自分だけに表示)").tag(String?.none)
                        }
                        .disabled(boards.isEmpty)
                    }
                }
                if editable {
                    editableFields
                } else if let current {
                    readOnly(current)
                }
                sourceSection
                if hub?.available != true {
                    Section { Text("このサーバはタスクに対応していません").foregroundStyle(.secondary) }
                }
                if let error {
                    Section { Text(error).foregroundStyle(.red).font(.footnote) }
                }
                if current?.canDelete == true {
                    Section {
                        Button("タスクを削除", role: .destructive) { confirmDelete = true }
                            .frame(maxWidth: .infinity)
                            .disabled(busy)
                    }
                }
            }
            .environment(\.timeZone, CalendarDates.zone)
            .environment(\.locale, Locale(identifier: "ja_JP")) // the date picker says 2026年10月5日, as the rest of the form
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(editable ? "キャンセル" : "閉じる") { dismiss() }
                }
                if editable {
                    ToolbarItem(placement: .confirmationAction) {
                        Button(task == nil ? "追加" : "保存") { Task { await save() } }
                            .disabled(!canSave)
                    }
                }
            }
            .alert("このタスクを削除しますか？", isPresented: $confirmDelete) {
                Button("キャンセル", role: .cancel) {}
                Button("削除する", role: .destructive) { Task { await remove() } }
            } message: {
                Text("「\(current?.title ?? draft.title)」")
            }
            .interactiveDismissDisabled(busy)
            .task(id: channelId) { await loadMembers() }
        }
    }

    private func boardName(_ id: String?) -> String {
        guard let id else { return "自分のタスク" }
        return "#" + (controller.store.channel(id)?.channel.name ?? task?.channelName ?? "?") + " のボード"
    }

    @ViewBuilder
    private var editableFields: some View {
        Section {
            TextField("題名 (例: 資料をまとめる)", text: $draft.title, axis: .vertical)
                .lineLimit(1...4)
                .onChange(of: draft.title) { _, _ in error = nil }
        } header: {
            if task != nil { Text(boardName(task?.channelId)) }
        } footer: {
            if let problem, problem != "題名を入れてください" { Text(problem).foregroundStyle(.red) }
        }
        Section("メモ") {
            TextField("Markdown で書けます", text: $draft.notes, axis: .vertical)
                .lineLimit(3...10)
        }
        Section("状態") {
            Picker("状態", selection: $draft.status) {
                ForEach(TaskStatus.allCases, id: \.self) { Text($0.label).tag($0) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
        }
        Section("期限") {
            if draft.dueOn.isEmpty {
                Button("期限を設定", systemImage: "calendar.badge.plus") { draft.dueOn = now }
            } else {
                DatePicker("期限", selection: Binding(get: { CalendarDates.parseDay(draft.dueOn) }, set: { draft.dueOn = CalendarDates.dayKey($0) }),
                           displayedComponents: [.date])
                Button("期限をなくす", systemImage: "xmark.circle", role: .destructive) { draft.dueOn = "" }
                    .tint(.red)
            }
        }
        if let channelId {
            Section {
                NavigationLink {
                    TaskAssigneePicker(controller: controller, memberIds: memberIds ?? members, selected: $draft.assigneeIds)
                } label: {
                    HStack(spacing: 8) {
                        Text(assigneeSummary)
                            .foregroundStyle(draft.assigneeIds.isEmpty ? Color.secondary : Color.primary)
                            .lineLimit(2)
                        Spacer(minLength: 0)
                        TaskAssigneeStack(controller: controller, ids: draft.assigneeIds, size: 24)
                    }
                }
                .accessibilityLabel("担当者")
                .accessibilityValue(assigneeSummary)
            } header: {
                Text(draft.assigneeIds.isEmpty ? "担当者" : "担当者 (\(draft.assigneeIds.count) 人)")
            } footer: {
                if task == nil, controller.store.channel(channelId) != nil { Text("加えた人には通知が届きます (自分を除く)") }
            }
        }
    }

    private var assigneeSummary: String {
        draft.assigneeIds.isEmpty ? "なし" : draft.assigneeIds.map { controller.store.users[$0]?.displayName ?? "?" }.joined(separator: "、")
    }

    /// What someone who may not change the board sees of the task.
    private func readOnly(_ task: TaskOut) -> some View {
        Section {
            Text(task.title)
                .font(.headline)
                .strikethrough(task.status == .done)
                .foregroundStyle(task.status == .done ? Color.secondary : Color.primary)
                .textSelection(.enabled)
            LabeledContent("状態", value: task.status.label)
            LabeledContent("期限", value: TaskRules.dueText(task.dueOn, today: now))
            if task.channelId != nil {
                LabeledContent("担当者") {
                    Text(task.assigneeIds.isEmpty ? "なし" : task.assigneeIds.map { controller.store.users[$0]?.displayName ?? "?" }.joined(separator: "、"))
                }
            }
            if let notes = task.notes {
                Text(notes).font(.subheadline).textSelection(.enabled)
            }
        } header: {
            Text(boardName(task.channelId))
        } footer: {
            Text("このボードを変更できるのは、チャンネルに投稿できるメンバーです。")
        }
    }

    @ViewBuilder
    private var sourceSection: some View {
        if let current {
            switch TaskRules.sourceState(current.source) {
            case .link(let messageId, let excerpt):
                Section("元のメッセージ") {
                    if let excerpt { Text(excerpt).font(.subheadline).lineLimit(3) }
                    Button("メッセージを開く", systemImage: "text.bubble") {
                        dismiss()
                        Task { await controller.openPermalink(messageId) }
                    }
                }
            case .deleted:
                Section("元のメッセージ") {
                    Label("元のメッセージは削除されました", systemImage: "text.bubble").font(.subheadline).foregroundStyle(.secondary)
                }
            case .none:
                EmptyView()
            }
        } else if draft.sourceMessageId != nil {
            Section("元のメッセージ") {
                Label(draft.sourceExcerpt ?? "メッセージ", systemImage: "text.bubble").font(.subheadline).lineLimit(3)
            }
        }
    }

    private func loadMembers() async {
        guard memberIds == nil, let channelId, let api = controller.api else { return }
        do {
            members = try await api.members(channelId: channelId).map(\.userId)
        } catch {
            self.error = controller.describe(error)
        }
    }

    private func save() async {
        guard let hub, canSave else { return }
        busy = true
        defer { busy = false }
        do {
            if let task {
                // Against the task as it was opened: only what I changed goes out (not a revert of someone else's change
                // that arrived while the form was open).
                let patch = draft.patch(from: task, tz: CalendarDates.zoneId)
                if !patch.isEmpty { _ = try await hub.update(task.id, patch) }
            } else {
                _ = try await hub.create(draft.create(clientTaskId: clientTaskId, tz: CalendarDates.zoneId))
                controller.notice = "タスクを作成しました"
            }
            dismiss()
        } catch {
            self.error = controller.describe(error)
        }
    }

    private func remove() async {
        guard let hub, let task = current else { return }
        busy = true
        defer { busy = false }
        do {
            try await hub.remove(task.id)
            dismiss()
        } catch {
            self.error = controller.describe(error)
        }
    }
}

/// 担当者: the channel's members (me first, then by name), each a check; a filter once there are many.
struct TaskAssigneePicker: View {
    @Bindable var controller: AppController
    /// nil while the members are read.
    let memberIds: [String]?
    @Binding var selected: [String]
    @State private var query = ""

    private struct Row: Identifiable {
        let id: String
        let name: String
        let username: String
    }

    private var rows: [Row] {
        let me = controller.store.me?.id
        // Someone already on the task who is not among the members read (yet): still shown, to take them off.
        let ids = (memberIds ?? []) + selected.filter { !(memberIds ?? []).contains($0) }
        return ids.map { id in
            let user = controller.store.users[id]
            return Row(id: id, name: user?.displayName ?? "?", username: user?.username ?? "")
        }
        .sorted { a, b in
            if (a.id == me) != (b.id == me) { return a.id == me }
            return a.name.localizedStandardCompare(b.name) == .orderedAscending
        }
    }

    var body: some View {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        let shown = q.isEmpty ? rows : rows.filter { $0.name.lowercased().contains(q) || $0.username.lowercased().contains(q) }
        List {
            if memberIds == nil && selected.isEmpty {
                ProgressView("読み込み中…").frame(maxWidth: .infinity)
            }
            ForEach(shown) { row in
                Button {
                    if selected.contains(row.id) { selected.removeAll { $0 == row.id } } else { selected.append(row.id) }
                } label: {
                    HStack(spacing: 10) {
                        AvatarView(id: row.id, name: row.name, size: 30)
                        Text(row.name).foregroundStyle(Color.primary)
                        if row.id == controller.store.me?.id { Text("(自分)").font(.caption).foregroundStyle(.secondary) }
                        Spacer(minLength: 0)
                        if selected.contains(row.id) {
                            Image(systemName: "checkmark").font(.body.weight(.semibold)).foregroundStyle(Color.accentColor)
                        }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(selected.contains(row.id) ? [.isSelected] : [])
            }
        }
        .modifier(SearchableWhenLong(enabled: rows.count > 8, query: $query))
        .navigationTitle(selected.isEmpty ? "担当者" : "担当者 (\(selected.count) 人)")
        .navigationBarTitleDisplayMode(.inline)
    }
}

private struct SearchableWhenLong: ViewModifier {
    let enabled: Bool
    @Binding var query: String

    func body(content: Content) -> some View {
        if enabled {
            content.searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "名前で絞り込む")
        } else {
            content
        }
    }
}
