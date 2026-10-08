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
    /// The members could not be read: the picker says so instead of 「読み込み中…」 for ever.
    @State private var membersFailed = false
    /// The conversation `members` were read (or are being read) for.
    @State private var membersFor: String?
    /// The server's answer to 「対応を始める」 / 「完了にする」, for a task outside the hub's windows (opened from a chip).
    @State private var answered: TaskOut?
    /// The creation's idempotency key: a retry after a failure never makes a second task (SYNC_PROTOCOL.md §16).
    @State private var clientTaskId = UUID().uuidString.lowercased()
    /// The task as opened, what 保存 compares the form with (M84: with the checkboxes sent one by one since).
    @State private var basis: TaskOut?
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
            _basis = State(initialValue: task)
        }
    }

    /// The task as it is now (an event may have changed it while the form is open).
    private var current: TaskOut? { task.flatMap { hub?.find($0.id) } ?? answered ?? task }
    /// The conversation whose members may be assigned: the task's, the board chosen, or (L9) the DM a new task comes from.
    private var channelId: String? { task?.channelId ?? draft.channelId ?? draft.dmChannelId }
    private var editable: Bool { current.map(controller.canEditTask) ?? true }
    private var problem: String? { editable ? draft.problem : nil }
    private var canSave: Bool { hub?.available == true && !busy && problem == nil && editable }
    private var now: DayKey { today ?? CalendarDates.today() }
    /// L9: a review request — 依頼先 first, 希望日 for the due date.
    private var isReview: Bool { (current?.kind ?? draft.kind) == .review }
    /// M86: a deadline — 締切日 (required), 事前の通知, no repeat, only on a channel's board.
    private var isDeadline: Bool { (current?.kind ?? draft.kind) == .deadline }
    private var assigneeLabel: String { isReview ? tr("依頼先") : tr("担当者") }
    private var dueLabel: String { isReview ? tr("希望日") : isDeadline ? tr("締切日") : tr("期限") }

    /// The boards a new task may go to besides 「自分のタスク」 (those I may still add to; a deadline: not as a guest).
    private var boards: [String] { draft.boardChoices.filter(isDeadline ? controller.canAddDeadline : controller.canEditBoard) }

    /// M86 (DEADLINES.md §8 4.): 「タスク / 締切」 — a new task on a channel's board (not a review request, not from a
    /// message or a canvas, not in a DM), for someone who may add a deadline there.
    private var showsKindSwitch: Bool {
        guard task == nil, draft.kind != .review, draft.sourceMessageId == nil, draft.sourceCanvasId == nil, draft.dmChannelId == nil,
              let channelId = draft.channelId else { return false }
        return controller.canAddDeadline(channelId)
    }

    private var title: String {
        guard task != nil else { return isReview ? tr("レビューを依頼") : isDeadline ? tr("締切を追加") : tr("タスクを追加") }
        if isReview { return tr("レビュー依頼") }
        if isDeadline { return editable ? tr("締切を編集") : tr("締切") }
        return editable ? tr("タスクを編集") : tr("タスク")
    }

    /// L9 (REVIEWS.md §2.2): an assignee's 「対応を始める」 / 「完了にする」, while the task is open.
    private var quickStatus: TaskOut? {
        guard let current, current.channelId != nil, current.status != .done, editable, hub?.available == true,
              let me = controller.store.me?.id, current.assigneeIds.contains(me) else { return nil }
        return current
    }

    var body: some View {
        NavigationStack {
            Form {
                if let quick = quickStatus { quickStatusSection(quick) }
                if showsKindSwitch {
                    Section {
                        Picker("種類", selection: Binding(get: { draft.kind }, set: { draft.setKind($0); error = nil })) {
                            Text("タスク").tag(TaskKind.task)
                            Text("⏰ 締切").tag(TaskKind.deadline)
                        }
                        .pickerStyle(.segmented)
                        .labelsHidden()
                        .accessibilityLabel("タスクか締切か")
                    }
                }
                if task == nil && !isReview && draft.dmChannelId == nil {
                    Section {
                        Picker("追加先", selection: Binding(get: { draft.channelId }, set: { id in
                            draft.channelId = id
                            draft.assigneeIds = []
                        })) {
                            ForEach(boards, id: \.self) { id in Text(boardName(id)).tag(String?.some(id)) }
                            if !isDeadline { Text("自分のタスク（自分だけに表示）").tag(String?.none) }  // M86: a deadline is a channel's
                        }
                        .disabled(boards.isEmpty || (isDeadline && boards.count == 1))
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
                        Button(isDeadline ? "締切を削除" : "タスクを削除", role: .destructive) { confirmDelete = true }
                            .frame(maxWidth: .infinity)
                            .disabled(busy)
                    }
                }
            }
            .environment(\.timeZone, CalendarDates.zone)
            .environment(\.locale, UILanguage.shared.locale) // the date picker says 2026年10月5日, as the rest of the form
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
            .alert(isDeadline ? "この締切を削除しますか？" : "このタスクを削除しますか？", isPresented: $confirmDelete) {
                Button("キャンセル", role: .cancel) {}
                Button("削除する", role: .destructive) { Task { await remove() } }
            } message: {
                Text(tr("「\(current?.title ?? draft.title)」") + (isDeadline ? "\n" + DeadlineRules.deleteNote : ""))
            }
            .interactiveDismissDisabled(busy)
            .task(id: channelId) { await loadMembers() }
        }
    }

    private func boardName(_ id: String?) -> String {
        guard let id else { return tr("自分のタスク") }
        if let state = controller.store.channel(id), state.channel.isDm { return tr("\(channelTitle(state, store: controller.store)) との DM") }  // L9
        return tr("#\(controller.store.channel(id)?.channel.name ?? task?.channelName ?? "?") のボード")
    }

    /// The header over the title: the task's board (or DM); a new review request says where it is asked.
    private var placeHeader: String? {
        if task != nil { return boardName(task?.channelId) }
        return isReview ? boardName(draft.channelId) : nil
    }

    @ViewBuilder
    private var editableFields: some View {
        if isReview { assigneeSection }
        Section {
            TextField(isDeadline ? "題名（例：全国大会 原稿）" : "題名（例：資料をまとめる）", text: $draft.title, axis: .vertical)
                .lineLimit(1...4)
                .onChange(of: draft.title) { _, _ in error = nil }
        } header: {
            if let placeHeader { Text(placeHeader) }
        } footer: {
            if let problem, problem != tr("題名を入れてください"), problem != tr("依頼先を選んでください"), problem != Self.noDeadlineDate {
                Text(problem).foregroundStyle(.red)
            }
        }
        Section("メモ") {
            TextField("Markdown で書けます", text: $draft.notes, axis: .vertical)
                .lineLimit(3...10)
        }
        if !(task == nil && isReview) {  // a new request starts 依頼中
            Section("状態") {
                Picker("状態", selection: $draft.status) {
                    ForEach(TaskStatus.allCases, id: \.self) { Text(TaskRules.statusLabel($0, kind: draft.kind)).tag($0) }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
            }
        }
        let due = dueLabel
        Section {
            if draft.dueOn.isEmpty {
                Button("\(due)を設定", systemImage: "calendar.badge.plus") { draft.dueOn = now }
            } else {
                DatePicker(due, selection: Binding(get: { CalendarDates.parseDay(draft.dueOn) }, set: { draft.dueOn = CalendarDates.dayKey($0) }),
                           displayedComponents: [.date])
                // M84 (TASKS.md §11.8 4.): a time on the device's clock, or none (the whole day).
                if draft.dueTime.isEmpty {
                    Button("時刻を設定", systemImage: "clock") { draft.dueTime = "09:00" }
                } else {
                    DatePicker("時刻", selection: Binding(get: { dueTimeDate }, set: { draft.dueTime = Self.hhmm($0) }),
                               displayedComponents: [.hourAndMinute])
                    Button("時刻なし", systemImage: "clock.badge.xmark") { draft.dueTime = "" }
                }
                if !isDeadline {  // M86: a deadline always has its date
                    Button("\(due)をなくす", systemImage: "xmark.circle", role: .destructive) { draft.clearDue() }
                        .tint(.red)
                }
            }
        } header: {
            Text(due)
        } footer: {
            if problem == Self.noDeadlineDate { Text(Self.noDeadlineDate).foregroundStyle(.red) }
        }
        // M84: 「繰り返し」 once there is a due date (the calendar's picker, starting on it); never for a review request
        // or (M86) a deadline.
        if !isReview && !isDeadline && !draft.dueOn.isEmpty {
            RepeatPickerSection(repetition: Binding(get: { draft.repetition }, set: { draft.repetition = $0; error = nil }), start: draft.dueOn,
                                note: tr("完了にすると、次の回のタスクができます"))
        }
        if isDeadline { noticeSection }
        if !(task == nil && isReview) { subtaskSection }
        if !isReview { assigneeSection }
    }

    static var noDeadlineDate: String { tr("締切の日付を入れてください") }

    /// M86 (DEADLINES.md §8 4.): 「事前の通知」 — 14 日前・7 日前・3 日前・前日・当日 (and any other day it already has), each a
    /// check; saved with the rest (PATCH `notice_days`, the whole set).
    private var noticeSection: some View {
        Section {
            ForEach(DeadlineRules.noticeRows(draft.noticeDays + (basis?.noticeDays ?? [])), id: \.self) { days in
                Toggle(DeadlineRules.noticeLabel(days), isOn: Binding(get: { draft.noticeDays.contains(days) }, set: { on in
                    if on {
                        draft.noticeDays = DeadlineRules.normalize(draft.noticeDays + [days])
                    } else {
                        draft.noticeDays.removeAll { $0 == days }
                    }
                }))
            }
        } header: {
            Text("事前の通知")
        } footer: {
            Text(draft.noticeDays.isEmpty ? tr("通知しません") : DeadlineRules.botNote)
        }
    }

    /// The due time on the due date, for the picker.
    private var dueTimeDate: Date {
        let parts = draft.dueTime.split(separator: ":").compactMap { Int($0) }
        return CalendarDates.at(draft.dueOn, hour: parts.first ?? 9, minute: parts.count > 1 ? parts[1] : 0)
    }

    static func hhmm(_ date: Date) -> String {
        let p = CalendarDates.local.dateComponents([.hour, .minute], from: date)
        return String(format: "%02d:%02d", p.hour ?? 0, p.minute ?? 0)
    }

    /// M84 (TASKS.md §11.8 4.): 「サブタスク」 — a checkbox, the title (editable), 上へ / 下へ / 削除, and 「サブタスクを追加」.
    /// The list goes with 保存; a saved item's checkbox goes at once (one item: someone else's change of the list stays).
    @ViewBuilder
    private var subtaskSection: some View {
        let doneCount = draft.subtasks.filter(\.done).count
        Section {
            ForEach(Array(draft.subtasks.enumerated()), id: \.element.key) { index, item in
                HStack(spacing: 8) {
                    Button { Task { await toggleSubtask(at: index) } } label: {
                        Image(systemName: item.done ? "checkmark.square.fill" : "square")
                            .font(.title3)
                            .foregroundStyle(item.done ? Color.accentColor : Color.secondary)
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel(item.done ? "「\(item.title)」を未完了に戻す" : "「\(item.title)」を完了にする")
                    TextField("サブタスク", text: Binding(get: { draft.subtasks.indices.contains(index) ? draft.subtasks[index].title : "" },
                                                     set: { if draft.subtasks.indices.contains(index) { draft.subtasks[index].title = $0 } }), axis: .vertical)
                        .strikethrough(item.done)
                        .foregroundStyle(item.done ? Color.secondary : Color.primary)
                        .accessibilityLabel("サブタスクの題名")
                    Menu {
                        Button("上へ", systemImage: "arrow.up") { swapSubtasks(index, index - 1) }.disabled(index == 0)
                        Button("下へ", systemImage: "arrow.down") { swapSubtasks(index, index + 1) }.disabled(index == draft.subtasks.count - 1)
                        Button("削除", systemImage: "trash", role: .destructive) { draft.subtasks.remove(at: index) }
                    } label: {
                        Image(systemName: "ellipsis").foregroundStyle(.secondary).frame(width: 28, height: 28).contentShape(Rectangle())
                    }
                    .accessibilityLabel("サブタスクの操作")
                }
            }
            if draft.subtasks.count < TaskRules.maxSubtasks {
                Button("サブタスクを追加", systemImage: "plus") { draft.subtasks.append(SubtaskDraft(title: "")) }
            }
        } header: {
            Text(draft.subtasks.isEmpty ? "サブタスク" : "サブタスク（\(doneCount)/\(draft.subtasks.count)）")
        }
    }

    private func swapSubtasks(_ a: Int, _ b: Int) {
        guard draft.subtasks.indices.contains(a), draft.subtasks.indices.contains(b) else { return }
        draft.subtasks.swapAt(a, b)
    }

    /// A checkbox: shown at once; a saved task's saved item goes to the server alone (PATCH …/subtasks/{sid}) and comes
    /// back unticked when refused.
    private func toggleSubtask(at index: Int) async {
        guard draft.subtasks.indices.contains(index) else { return }
        let item = draft.subtasks[index]
        let done = !item.done
        draft.subtasks[index].done = done
        guard let task, let hub, let subtaskId = item.id, let base = basis, base.subtasks.contains(where: { $0.id == subtaskId }) else { return }
        do {
            let answer = try await hub.toggleSubtask(task.id, subtaskId, done: done)
            // What I compare with on 保存: the item as the server has it now (so it is not sent again).
            basis = TaskRules.withSubtask(base, subtaskId, done: answer.subtasks.first { $0.id == subtaskId }?.done ?? done)
            answered = answer
            error = nil
        } catch {
            if let at = draft.subtasks.firstIndex(where: { $0.id == subtaskId }) { draft.subtasks[at].done = item.done }
            self.error = controller.describe(error)
        }
    }

    /// 担当者 (依頼先 for a review request, shown first): the conversation's members.
    @ViewBuilder
    private var assigneeSection: some View {
        if let channelId {
            Section {
                NavigationLink {
                    // A new review request does not ask me (REVIEWS.md §9, as the desktop and Android).
                    TaskAssigneePicker(controller: controller, memberIds: memberIds ?? members, selected: $draft.assigneeIds, title: assigneeLabel,
                                       excludeMe: task == nil && isReview, failed: membersFailed,
                                       membersHint: !(controller.store.channel(channelId)?.channel.isDm ?? false))
                } label: {
                    HStack(spacing: 8) {
                        Text(assigneeSummary)
                            .foregroundStyle(draft.assigneeIds.isEmpty ? Color.secondary : Color.primary)
                            .lineLimit(2)
                        Spacer(minLength: 0)
                        TaskAssigneeStack(controller: controller, ids: draft.assigneeIds, size: 24)
                    }
                }
                .accessibilityLabel(assigneeLabel)
                .accessibilityValue(assigneeSummary)
            } header: {
                Text(draft.assigneeIds.isEmpty ? assigneeLabel : tr("\(assigneeLabel)（\(draft.assigneeIds.count) 人）"))
            } footer: {
                if task == nil {
                    if isReview {
                        Text("選んだ人にレビューの依頼が届きます。状態はメッセージの下に表示されます")
                    } else if draft.channelId == nil && draft.dmChannelId != nil {
                        Text("担当者を選ぶと、この DM のメンバーにも表示されます（選ばなければ自分だけのタスク）")
                    } else if controller.store.channel(channelId) != nil {
                        Text("加えた人には通知が届きます（自分を除く）")
                    }
                }
            }
        } else if task == nil && !isReview && !isDeadline {
            personalAssigneeSection
        }
    }

    /// A new task for 「自分のタスク」 has no assignees (TASKS.md §1): say so where they would be, and offer the boards
    /// right there — choosing one brings its members (2026-10-09, testers looked for others and found only themselves).
    private var personalAssigneeSection: some View {
        Section {
            if !boards.isEmpty {
                Menu {
                    ForEach(boards, id: \.self) { id in
                        Button(boardName(id)) {
                            draft.channelId = id
                            draft.assigneeIds = []
                        }
                    }
                } label: {
                    Label("ボードを選ぶ", systemImage: "person.2")
                }
            }
        } header: {
            Text(assigneeLabel)
        } footer: {
            Text(boards.isEmpty ? "自分のタスクには担当者を付けられません。担当者を付けられるのは、チャンネルのボードのタスクです。"
                 : "自分のタスクには担当者を付けられません。チャンネルのボードを選ぶと、そのメンバーから選べます。")
        }
    }

    /// The assignee's big buttons: 「対応を始める」 (未着手 → 進行中) and 「完了にする」.
    private func quickStatusSection(_ task: TaskOut) -> some View {
        Section {
            VStack(spacing: 10) {
                if task.status == .todo {
                    Button { Task { await setStatus(task, .doing) } } label: {
                        Label("対応を始める", systemImage: "play.fill").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                }
                Button { Task { await setStatus(task, .done) } } label: {
                    Label("完了にする", systemImage: "checkmark").frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
            }
            .controlSize(.large)
            .font(.body.weight(.semibold))
            .disabled(busy)
            .listRowInsets(EdgeInsets())
            .listRowBackground(Color.clear)
        } footer: {
            if task.kind == .review && task.ownerId != controller.store.me?.id { Text("完了にすると、依頼した人に通知が届きます") }
        }
    }

    private var assigneeSummary: String {
        draft.assigneeIds.isEmpty ? tr("なし") : draft.assigneeIds.map { controller.store.users[$0]?.displayName ?? "?" }.joined(separator: tr("、"))
    }

    /// What someone who may not change the board sees of the task.
    private func readOnly(_ task: TaskOut) -> some View {
        Section {
            Text(task.title)
                .font(.headline)
                .strikethrough(task.status == .done)
                .foregroundStyle(task.status == .done ? Color.secondary : Color.primary)
                .textSelection(.enabled)
            LabeledContent("状態", value: TaskRules.statusLabel(task.status, kind: task.kind))
            LabeledContent(dueLabel, value: TaskRules.dueText(task.dueOn, today: now, dueAt: task.dueAt))
            if task.kind == .deadline {  // M86
                LabeledContent("事前の通知", value: DeadlineRules.noticeSummary(task.noticeDays))
            }
            if let rrule = task.rrule {  // M84
                LabeledContent("繰り返し") {
                    Label(CalendarRecurrence.describe(rrule, start: TaskRules.dueDay(task) ?? now), systemImage: "repeat")
                }
            }
            if let progress = TaskRules.subtaskProgress(task) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("サブタスク（\(progress.done)/\(progress.total)）").font(.subheadline).foregroundStyle(.secondary)
                    ForEach(task.subtasks) { item in
                        Text("\(item.done ? "☑" : "☐") \(Text(item.title).strikethrough(item.done))")
                            .font(.subheadline)
                            .foregroundStyle(item.done ? Color.secondary : Color.primary)
                    }
                }
            }
            if task.channelId != nil {
                LabeledContent(assigneeLabel) {
                    Text(task.assigneeIds.isEmpty ? tr("なし") : task.assigneeIds.map { controller.store.users[$0]?.displayName ?? "?" }.joined(separator: tr("、")))
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
                Label(draft.sourceExcerpt ?? tr("メッセージ"), systemImage: "text.bubble").font(.subheadline).lineLimit(3)
            }
        }
        canvasSourceSection
    }

    /// M73 (CANVAS.md §18.3): 「元のキャンバス」 — its title and the item, opening the canvas; 「元のキャンバスは削除されました」
    /// once it was purged. A new task from a checklist item shows the item.
    @ViewBuilder
    private var canvasSourceSection: some View {
        if let current {
            switch TaskRules.canvasSourceState(current.canvasSource) {
            case .link(let canvasId, let excerpt):
                Section(canvasHeader(canvasId)) {
                    if let excerpt { Text(excerpt).font(.subheadline).lineLimit(3) }
                    Button("キャンバスを開く", systemImage: "doc.text") {
                        dismiss()
                        Task {
                            try? await Task.sleep(for: .milliseconds(350)) // the form is gone before the conversation moves
                            // A shared task comes from its own conversation's canvas (§18.3); a personal one's is looked up.
                            await controller.openCanvas(canvasId, channelId: current.channelId)
                        }
                    }
                }
            case .deleted(let excerpt):
                Section("元のキャンバス") {
                    if let excerpt { Text(excerpt).font(.subheadline).foregroundStyle(.secondary).lineLimit(3) }
                    Label("元のキャンバスは削除されました", systemImage: "doc.text").font(.subheadline).foregroundStyle(.secondary)
                }
            case .none:
                EmptyView()
            }
        } else if let canvasId = draft.sourceCanvasId {
            Section(canvasHeader(canvasId)) {
                Label(draft.sourceCanvasExcerpt ?? tr("チェックリストの項目"), systemImage: "checklist").font(.subheadline).lineLimit(3)
            }
        }
    }

    /// 「元のキャンバス: 議事録」 when this device knows its title.
    private func canvasHeader(_ canvasId: String) -> String {
        guard let title = controller.store.canvasMeta(canvasId)?.title, !title.isEmpty else { return tr("元のキャンバス") }
        return tr("元のキャンバス：") + title
    }

    private func loadMembers() async {
        guard memberIds == nil, let channelId else {
            members = nil
            membersFor = nil
            return
        }
        // Read (or being read) for this conversation already: the form comes back from the picker it pushed.
        if membersFor == channelId && !membersFailed { return }
        // Another board chosen: not the previous board's people while its own are read.
        members = nil
        membersFailed = false
        membersFor = channelId
        // A DM's members are known here (L9).
        if let state = controller.store.channel(channelId), state.channel.isDm, let ids = state.channel.dmUserIds, !ids.isEmpty {
            members = ids
            return
        }
        guard let api = controller.api else { return }
        // Not tied to the form being on screen: the form disappears under the picker it pushes, which may cancel this
        // `.task`; a read cancelled that way left the picker on 「読み込み中…」.
        let read = Task { try await api.members(channelId: channelId).map(\.userId) }
        do {
            let ids = try await read.value
            guard membersFor == channelId else { return }
            members = ids
        } catch {
            guard membersFor == channelId else { return }
            membersFailed = true
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
                let patch = draft.patch(from: basis ?? task, tz: CalendarDates.zoneId)
                if !patch.isEmpty { _ = try await hub.update(task.id, patch) }
            } else {
                // M73: the server looks for a checklist item's line in the saved body, so what is typed goes first.
                if let canvasId = draft.sourceCanvasId { await controller.engine?.canvases.current(canvasId)?.flush() }
                _ = try await hub.create(draft.create(clientTaskId: clientTaskId, tz: CalendarDates.zoneId))
                controller.notice = draft.kind == .review ? tr("レビューを依頼しました") : draft.kind == .deadline ? tr("締切を追加しました") : tr("タスクを作成しました")
            }
            dismiss()
        } catch {
            self.error = controller.describe(error)
        }
    }

    /// 「対応を始める」 / 「完了にする」: at once (the form stays open on the new state).
    private func setStatus(_ task: TaskOut, _ status: TaskStatus) async {
        guard let hub else { return }
        busy = true
        defer { busy = false }
        do {
            answered = try await hub.update(task.id, TaskPatch(status: status))
            draft.status = status
            error = nil
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
    /// The page's title (L6's 「提出する人」 picks people the same way).
    var title = tr("担当者")
    /// M95: one person only (a workflow's 「人」 field without `multiple`): a pick replaces the one chosen.
    var single = false
    /// A new review request: asking myself makes no sense (REVIEWS.md §9).
    var excludeMe = false
    /// The members could not be read.
    var failed = false
    /// A task's 担当者: when I am the only one to pick, say how others come in.
    var membersHint = false
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
        return ids.filter { !excludeMe || $0 != me }.map { id in
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
        let me = controller.store.me?.id
        List {
            if failed && memberIds == nil {
                Text("メンバーを読み込めませんでした").foregroundStyle(.secondary)
            } else if memberIds == nil && selected.isEmpty {
                ProgressView("読み込み中…").frame(maxWidth: .infinity)
            } else if memberIds != nil && rows.isEmpty {
                Text("選べる人がいません").foregroundStyle(.secondary)
            }
            ForEach(shown) { row in
                Button {
                    if selected.contains(row.id) { selected.removeAll { $0 == row.id } } else if single { selected = [row.id] } else { selected.append(row.id) }
                } label: {
                    HStack(spacing: 10) {
                        AvatarView(id: row.id, name: row.name, size: 30)
                        Text(row.name).foregroundStyle(Color.primary)
                        if row.id == controller.store.me?.id { Text("（自分）").font(.caption).foregroundStyle(.secondary) }
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
            // A conversation with nobody but me (a board I am alone in): where the others come from.
            if membersHint && memberIds != nil && !rows.isEmpty && rows.allSatisfy({ $0.id == me }) {
                Text("ほかの人を選ぶには、その人をこのチャンネルに追加してください").font(.footnote).foregroundStyle(.secondary)
                    .listRowSeparator(.hidden)
            }
        }
        .modifier(SearchableWhenLong(enabled: rows.count > 8, query: $query))
        .navigationTitle(selected.isEmpty ? title : tr("\(title)（\(selected.count) 人）"))
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
