import SwiftUI

/// What the task form opens on: a new task (its draft) or a task I see.
enum TaskFormTarget: Identifiable {
    case new(TaskDraft)
    case task(TaskOut)

    var id: String {
        switch self {
        case .new: "new"
        case .task(let task): task.id
        }
    }
}

/// Assignees as overlapping avatars, three at most, then 「+N」.
struct TaskAssigneeStack: View {
    @Bindable var controller: AppController
    let ids: [String]
    var size: CGFloat = 20

    var body: some View {
        if !ids.isEmpty {
            let shown = Array(ids.prefix(TaskRules.cardAvatars))
            let more = ids.count - shown.count
            HStack(spacing: -size * 0.3) {
                ForEach(shown, id: \.self) { id in
                    AvatarView(id: id, name: name(id), size: size)
                        .overlay(RoundedRectangle(cornerRadius: size / 4, style: .continuous).stroke(Color(.systemBackground), lineWidth: 1.5))
                }
                if more > 0 {
                    Text("+\(more)")
                        .font(.system(size: size * 0.5, weight: .semibold))
                        .foregroundStyle(.secondary)
                        .frame(minWidth: size, minHeight: size)
                        .background(Color(.tertiarySystemFill), in: Capsule())
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("担当: " + ids.map(name).joined(separator: "、"))
        }
    }

    private func name(_ id: String) -> String { controller.store.users[id]?.displayName ?? "?" }
}

/// A card's title and its marks: 進行中 (in 「自分のタスク」), the due date (red when overdue and not done, bold today),
/// メモ, 元のメッセージ, the assignees.
struct TaskCardContent: View {
    @Bindable var controller: AppController
    let task: TaskOut
    let today: DayKey
    var showStatus = false

    var body: some View {
        let done = task.status == .done
        let overdue = TaskRules.isOverdue(task, today: today)
        let source = TaskRules.sourceState(task.source)
        let hasSource = if case .link = source { true } else { false }
        let hasCanvas = if case .link = TaskRules.canvasSourceState(task.canvasSource) { true } else { false }
        let hasMeta = task.dueOn != nil || task.notes != nil || hasSource || hasCanvas || !task.assigneeIds.isEmpty || (showStatus && task.status == .doing)
        VStack(alignment: .leading, spacing: 5) {
            Text(task.title)
                .font(.subheadline)
                .strikethrough(done)
                .foregroundStyle(done ? Color.secondary : Color.primary)
                .multilineTextAlignment(.leading)
                .frame(maxWidth: .infinity, alignment: .leading)
            if hasMeta {
                HStack(spacing: 8) {
                    if showStatus && task.status == .doing {
                        Text(TaskRules.statusLabel(task.status, kind: task.kind))  // 対応中 for a review request (L9)
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(Color.accentColor)
                            .padding(.horizontal, 5).padding(.vertical, 1)
                            .background(Color.accentColor.opacity(0.14), in: RoundedRectangle(cornerRadius: 4))
                    }
                    if let due = task.dueOn {
                        Label(TaskRules.dueLabel(due, today: today), systemImage: "calendar")
                            .labelStyle(TightLabelStyle())
                            .monospacedDigit()
                            .fontWeight(overdue || (due == today && !done) ? .semibold : .regular)
                            .foregroundStyle(overdue ? Color.red : due == today && !done ? Color.primary : Color.secondary)
                            .accessibilityLabel("期限 " + TaskRules.dueText(due, today: today) + (overdue ? "、過ぎています" : ""))
                    }
                    if task.notes != nil {
                        Image(systemName: "note.text").accessibilityLabel("メモあり")
                    }
                    if hasSource {
                        Image(systemName: "text.bubble").accessibilityLabel("元のメッセージあり")
                    }
                    if hasCanvas {
                        Image(systemName: "doc.text").accessibilityLabel("元のキャンバスあり")  // M73
                    }
                    Spacer(minLength: 0)
                    TaskAssigneeStack(controller: controller, ids: task.assigneeIds)
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
        }
        .contentShape(Rectangle())
    }
}

private struct TightLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 2) {
            configuration.icon
            configuration.title
        }
    }
}

/// 「＋ 追加」: a title field; Return adds and keeps it open for the next one, an empty field closes it when left.
struct TaskInlineAdd: View {
    var label = "追加"
    let onAdd: (String) async -> Bool
    @State private var open = false
    @State private var title = ""
    @State private var busy = false
    @FocusState private var focused: Bool

    var body: some View {
        if open {
            HStack(spacing: 8) {
                TextField("題名を入力して改行", text: $title)
                    .focused($focused)
                    .submitLabel(.done)
                    .disabled(busy)
                    .onSubmit { Task { await submit() } }
                    .onChange(of: focused) { _, now in if !now && TaskRules.cleanTitle(title).isEmpty && !busy { close() } }
                    .accessibilityLabel("新しいタスクの題名")
                Button("閉じる") { close() }.font(.subheadline)
            }
            .padding(.horizontal, 12).padding(.vertical, 9)
            .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.accentColor.opacity(0.6)))
        } else {
            Button {
                open = true
                focused = true
            } label: {
                Label(label, systemImage: "plus").font(.subheadline).frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.borderless)
            .padding(.horizontal, 4).padding(.vertical, 6)
        }
    }

    private func close() {
        open = false
        title = ""
        focused = false
    }

    private func submit() async {
        let text = TaskRules.cleanTitle(title)
        guard !text.isEmpty, !busy else { return }
        busy = true
        let ok = await onAdd(String(text.prefix(TaskRules.maxTitle)))
        busy = false
        if ok { title = "" }
        focused = true // the next one
    }
}

/// M56 (TASKS.md §6, the phone column): a channel's 「タスク」 tab (public and private channels). The columns 未着手 / 進行中 /
/// 完了 are switched at the top (with their counts), the chosen column's cards below in the server's order, 「＋ 追加」
/// under them. A card's long press (or its ⋯) moves it to another column, up or down, or deletes it (who may). Read-only,
/// with the reason over it, for those who may not post in the channel.
struct ChannelTasksPane: View {
    @Bindable var controller: AppController
    let channel: ChannelState
    /// Tests pass their own hub, day and column.
    var hub: TaskHub? = nil
    var today: DayKey? = nil
    @State var column: TaskStatus = .todo
    @State private var form: TaskFormTarget?
    @State private var deleting: TaskOut?

    private var taskHub: TaskHub? { hub ?? controller.taskHub }
    private var now: DayKey { today ?? CalendarDates.today() }

    var body: some View {
        let hub = taskHub
        let board = hub?.board(channel.id)
        let tasks = board?.tasks ?? []
        let canEdit = TaskRules.canEditBoard(channel, isAdmin: controller.isAdmin) && hub?.available == true
        let cards = TaskRules.column(tasks, column)
        let note = TaskRules.boardNote(board?.state, channel: channel, canEdit: canEdit)
        VStack(spacing: 0) {
            Picker("列", selection: $column) {
                ForEach(TaskStatus.allCases, id: \.self) { status in
                    Text(segmentTitle(status, tasks: tasks, board: board)).tag(status)
                }
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
            if let note {
                Text(note)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 16).padding(.vertical, 6)
                    .background(Color.orange.opacity(0.12))
            }
            Divider()
            if hub == nil {
                CalendarNote(title: "接続すると表示します", systemImage: "checklist")
            } else if board?.state == .unsupported {
                CalendarNote(title: "このサーバはタスクに対応していません", systemImage: "checklist", detail: "サーバの更新後に使えるようになります。")
            } else {
                ScrollView {
                    LazyVStack(spacing: 8) {
                        ForEach(cards) { task in card(task, column: cards, canEdit: canEdit) }
                        if cards.isEmpty {
                            Text(board == nil || board?.state == .loading ? "読み込み中…" : emptyText(canEdit: canEdit))
                                .font(.subheadline).foregroundStyle(.secondary)
                                .frame(maxWidth: .infinity).padding(.vertical, 20)
                        }
                        if column == .done && board?.allDone != true && cards.count >= TaskRules.boardDoneLimit {
                            Button("完了をすべて表示") { Task { await hub?.openBoard(channel.id, allDone: true) } }
                                .font(.subheadline)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        if canEdit {
                            TaskInlineAdd { title in await add(title) }
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                }
                .refreshable { await hub?.reloadBoard(channel.id) }
            }
        }
        .task(id: channel.id) { await taskHub?.openBoard(channel.id) }
        .onDisappear { if form == nil { taskHub?.closeBoard(channel.id) } }
        .onChange(of: controller.taskOpen, initial: true) { _, open in
            // A task's notification (M56): shown over this channel's tab, in its column.
            guard let open, open.channelId == channel.id, let taskId = open.taskId, let hub = taskHub else { return }
            controller.taskOpen = nil
            Task {
                do {
                    let task = try await hub.load(taskId)
                    column = task.status
                    form = .task(task)
                } catch {
                    controller.error = controller.describe(error)
                }
            }
        }
        .fullScreenCover(item: $form) { target in
            TaskForm(controller: controller, hub: taskHub, target: target)
        }
        .alert("このタスクを削除しますか？", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), presenting: deleting) { task in
            Button("キャンセル", role: .cancel) {}
            Button("削除する", role: .destructive) { Task { await remove(task) } }
        } message: { task in
            Text("「\(task.title)」")
        }
    }

    /// 「未着手 3」「進行中 1」「完了」 (TASKS.md §6: the completed column has no count, it holds only the latest 100).
    private func segmentTitle(_ status: TaskStatus, tasks: [TaskOut], board: TaskList?) -> String {
        guard status != .done, board?.state == .ready || !tasks.isEmpty else { return status.label }
        return "\(status.label) \(tasks.filter { $0.status == status }.count)"
    }

    private func emptyText(canEdit: Bool) -> String {
        switch column {
        case .todo: canEdit ? "未着手のタスクはありません。下の「追加」から足せます" : "未着手のタスクはありません"
        case .doing: "進行中のタスクはありません"
        case .done: "完了したタスクはありません"
        }
    }

    private func card(_ task: TaskOut, column cards: [TaskOut], canEdit: Bool) -> some View {
        HStack(alignment: .top, spacing: 4) {
            Button { form = .task(task) } label: {
                TaskCardContent(controller: controller, task: task, today: now)
            }
            .buttonStyle(.plain)
            .accessibilityHint("タスクを開く")
            if canEdit || task.canDelete || canvasOf(task) != nil {
                Menu { menu(task, column: cards, canEdit: canEdit) } label: {
                    Image(systemName: "ellipsis")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .frame(width: 30, height: 24)
                        .contentShape(Rectangle())
                }
                .accessibilityLabel("「\(task.title)」の操作")
            }
        }
        .padding(.leading, 12).padding(.trailing, 6).padding(.vertical, 10)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(Color(.separator).opacity(0.5), lineWidth: 0.5))
        .contentShape(.contextMenuPreview, RoundedRectangle(cornerRadius: 10, style: .continuous))
        .contextMenu { if canEdit || task.canDelete || canvasOf(task) != nil { menu(task, column: cards, canEdit: canEdit) } }
    }

    /// M73: the canvas a card was made from, while it is there.
    private func canvasOf(_ task: TaskOut) -> String? {
        if case .link(let canvasId, _) = TaskRules.canvasSourceState(task.canvasSource) { return canvasId }
        return nil
    }

    /// The card's actions: 移動 (another column), 上へ / 下へ, 削除 (who may) — what dragging does on the web.
    @ViewBuilder
    private func menu(_ task: TaskOut, column cards: [TaskOut], canEdit: Bool) -> some View {
        if canEdit {
            Menu {
                ForEach(TaskStatus.allCases.filter { $0 != task.status }, id: \.self) { status in
                    Button(status.label) { move(task, to: status, .none) }
                }
            } label: {
                Label("移動", systemImage: "arrow.left.arrow.right")
            }
            let up = TaskRules.moveWithin(cards, task.id, -1)
            let down = TaskRules.moveWithin(cards, task.id, 1)
            Button("上へ", systemImage: "arrow.up") { if let up { move(task, to: task.status, up) } }.disabled(up == nil)
            Button("下へ", systemImage: "arrow.down") { if let down { move(task, to: task.status, down) } }.disabled(down == nil)
        }
        if let canvasId = canvasOf(task) {
            Button("元のキャンバスを開く", systemImage: "doc.text") { Task { await controller.openCanvas(canvasId, channelId: channel.id, navigate: false) } }
        }
        if task.canDelete {
            Button("削除", systemImage: "trash", role: .destructive) { deleting = task }
        }
    }

    private func move(_ task: TaskOut, to status: TaskStatus, _ neighbors: TaskNeighbors) {
        guard let hub = taskHub else { return }
        Task {
            do { try await hub.move(task.id, to: status, neighbors) } catch { controller.error = controller.describe(error) }
        }
    }

    private func add(_ title: String) async -> Bool {
        guard let hub = taskHub else { return false }
        do {
            _ = try await hub.create(TaskCreate(channelId: channel.id, title: title, status: column, clientTaskId: UUID().uuidString.lowercased(),
                                                tz: CalendarDates.zoneId))
            return true
        } catch {
            controller.error = controller.describe(error)
            return false
        }
    }

    private func remove(_ task: TaskOut) async {
        do { try await taskHub?.remove(task.id) } catch { controller.error = controller.describe(error) }
    }
}

/// The circle that completes a task in 「自分のタスク」 (and takes it back).
struct TaskCheckbox: View {
    let task: TaskOut
    let enabled: Bool
    let toggle: () -> Void

    var body: some View {
        let done = task.status == .done
        Button(action: toggle) {
            Image(systemName: done ? "checkmark.circle.fill" : "circle")
                .font(.title3)
                .foregroundStyle(done ? Color.accentColor : Color.secondary)
                .frame(width: 30, height: 30)
                .contentShape(Rectangle())
        }
        .buttonStyle(.borderless)
        .disabled(!enabled)
        .accessibilityLabel(done ? "「\(task.title)」を未完了に戻す" : "「\(task.title)」を完了にする")
    }
}

/// M56 (TASKS.md §6): 「タスク」 from the home's tile — 「自分のタスク」, my personal list (the circle completes a task,
/// 「＋ 追加」 adds one, the completed ones fold under 「完了 (N)」), and 「自分の担当」, the shared tasks assigned to me, by
/// channel (its name opens that channel's 「タスク」 tab; a DM's go by the other person's name, L9), and 「自分が依頼した」
/// (L9, GET /tasks/requested): the shared tasks I made with someone else assigned, by date.
struct MyTasksView: View {
    static let selectionId = "tasks"

    @Bindable var controller: AppController
    /// Tests pass their own hub and day.
    var hub: TaskHub? = nil
    var today: DayKey? = nil
    /// A channel's 「タスク」 tab.
    var onOpenBoard: (String) -> Void = { _ in }
    @State var showDone = false
    @State private var form: TaskFormTarget?

    private var taskHub: TaskHub? { hub ?? controller.taskHub }
    private var now: DayKey { today ?? CalendarDates.today() }

    var body: some View {
        let hub = taskHub
        let list = hub?.mine
        let me = controller.store.me?.id
        // A DM's tasks (L9) go by the other members' names.
        let mine = TaskRules.groupMine(list?.tasks ?? [], me: me) { id in controller.store.channel(id).map { _ in controller.taskPlaceName(id, fallback: nil) } }
        let personal = TaskRules.splitOpenDone(mine.personal)
        let loading = list == nil || list?.state == .loading
        let requested = hub?.requested
        List {
            if hub == nil {
                Section { Text("接続すると表示します").foregroundStyle(.secondary) }
            } else if list?.state == .unsupported {
                Section { Text("このサーバはタスクに対応していません").foregroundStyle(.secondary) }
            } else if list?.state == .failed {
                Section { Text("タスクを読み込めませんでした。下に引いて読み直せます").font(.footnote).foregroundStyle(.secondary) }
            }
            Section {
                if personal.open.isEmpty && personal.done.isEmpty {
                    Text(loading ? "読み込み中…" : "個人用のタスクはまだありません").font(.subheadline).foregroundStyle(.secondary)
                }
                ForEach(personal.open) { row($0) }
                if hub?.available == true && list?.state != .unsupported {
                    TaskInlineAdd { title in await addPersonal(title) }
                }
                if !personal.done.isEmpty {
                    DisclosureGroup("完了 (\(personal.done.count))", isExpanded: $showDone) {
                        ForEach(personal.done) { row($0) }
                    }
                    .font(.subheadline)
                }
            } header: {
                HStack(spacing: 6) {
                    Text("自分のタスク")
                    Text("自分だけに表示").font(.caption).foregroundStyle(.secondary).textCase(nil)
                }
            }
            if mine.groups.isEmpty {
                Section("自分の担当") {
                    Text(loading ? "読み込み中…" : "担当のタスクはありません").font(.subheadline).foregroundStyle(.secondary)
                }
            } else {
                ForEach(Array(mine.groups.enumerated()), id: \.element.channelId) { index, group in
                    Section {
                        let split = TaskRules.splitOpenDone(group.tasks)
                        ForEach(split.open + split.done) { row($0) }
                    } header: {
                        VStack(alignment: .leading, spacing: 6) {
                            if index == 0 { Text("自分の担当") }
                            if controller.isDmTask(group.channelId) {
                                // L9: a DM has no board to open.
                                Label(group.channelName, systemImage: "person").textCase(nil).font(.footnote.weight(.semibold))
                            } else {
                                Button { onOpenBoard(group.channelId) } label: {
                                    HStack(spacing: 3) {
                                        Text(glyph(group.channelId) + group.channelName).textCase(nil)
                                        Image(systemName: "chevron.right").font(.caption2.weight(.semibold))
                                    }
                                    .font(.footnote.weight(.semibold))
                                }
                                .buttonStyle(.borderless)
                                .accessibilityLabel("#\(group.channelName) のタスクを開く")
                            }
                        }
                    }
                }
            }
            // L9 (REVIEWS.md §2.3): the shared tasks I made with someone else assigned — my review requests and the like.
            if requested?.state != .unsupported && hub != nil {
                let split = TaskRules.sortRequested(requested?.tasks ?? [])
                Section("自分が依頼した") {
                    if split.open.isEmpty && split.done.isEmpty {
                        Text(requested == nil || requested?.state == .loading ? "読み込み中…"
                             : requested?.state == .failed ? "読み込めませんでした。下に引いて読み直せます" : "依頼したタスクはありません")
                            .font(.subheadline).foregroundStyle(.secondary)
                    }
                    ForEach(split.open + split.done) { requestedRow($0) }
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("タスク")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { form = .new(TaskDraft()) } label: { Image(systemName: "plus") }
                    .accessibilityLabel("タスクを追加")
                    .disabled(hub?.available != true)
            }
        }
        .refreshable {
            let hub = taskHub
            let requested = Task { await hub?.reloadRequested() }
            await hub?.reloadMine()
            await requested.value
        }
        .task {
            let hub = taskHub
            let requested = Task { await hub?.openRequested() }  // L9, beside 「自分のタスク」
            await hub?.openMine()
            await requested.value
        }
        .onDisappear {
            if form == nil {
                taskHub?.closeMine()
                taskHub?.closeRequested()
            }
        }
        .onChange(of: controller.taskOpen, initial: true) { _, open in
            // A notification of my own task (M56): shown here.
            guard let open, open.channelId == nil, let taskId = open.taskId, let hub = taskHub else { return }
            controller.taskOpen = nil
            Task {
                do { form = .task(try await hub.load(taskId)) } catch { controller.error = controller.describe(error) }
            }
        }
        .fullScreenCover(item: $form) { target in
            TaskForm(controller: controller, hub: taskHub, target: target)
        }
    }

    private func glyph(_ channelId: String) -> String {
        controller.store.channel(channelId)?.channel.type == "private" ? "🔒 " : "# "
    }

    private func row(_ task: TaskOut) -> some View {
        HStack(alignment: .top, spacing: 8) {
            TaskCheckbox(task: task, enabled: controller.canEditTask(task) && taskHub?.available == true) { toggleDone(task) }
                .padding(.top, -4)
            Button { form = .task(task) } label: {
                TaskCardContent(controller: controller, task: task, today: now, showStatus: true)
            }
            .buttonStyle(.borderless)
            .tint(.primary)
        }
    }

    /// 「自分が依頼した」's row: the card, and under it what it is and where (a DM by the other person's name).
    private func requestedRow(_ task: TaskOut) -> some View {
        Button { form = .task(task) } label: {
            VStack(alignment: .leading, spacing: 4) {
                TaskCardContent(controller: controller, task: task, today: now, showStatus: true)
                Text(TaskRules.kindLabel(task.kind) + " · " + place(task) + (task.status == .done ? " · 完了" : ""))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .buttonStyle(.borderless)
        .tint(.primary)
    }

    private func place(_ task: TaskOut) -> String {
        guard let channelId = task.channelId else { return "自分のタスク" }
        let name = controller.taskPlaceName(channelId, fallback: task.channelName)
        if controller.isDmTask(channelId) || (controller.store.channel(channelId) == nil && task.channelName == nil) { return name }
        return glyph(channelId) + name
    }

    private func toggleDone(_ task: TaskOut) {
        guard let hub = taskHub else { return }
        Task {
            do { _ = try await hub.update(task.id, TaskPatch(status: task.status == .done ? .todo : .done)) } catch {
                controller.error = controller.describe(error)
            }
        }
    }

    private func addPersonal(_ title: String) async -> Bool {
        guard let hub = taskHub else { return false }
        do {
            _ = try await hub.create(TaskCreate(channelId: nil, title: title, clientTaskId: UUID().uuidString.lowercased(), tz: CalendarDates.zoneId))
            return true
        } catch {
            controller.error = controller.describe(error)
            return false
        }
    }
}

/// M56: a task due that day in the calendar, an all-day row 「☐ 題名」 (done 「☑」, struck through) in its board's colour.
struct CalendarTaskRow: View {
    let task: TaskOut
    let showCalendar: Bool

    var body: some View {
        let done = task.status == .done
        HStack(alignment: .top, spacing: 10) {
            Text("期限")
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(width: 86, alignment: .leading)
                .padding(.top, 2)
            RoundedRectangle(cornerRadius: 2).fill(CalendarDates.color(task.channelId)).frame(width: 4)
            VStack(alignment: .leading, spacing: 2) {
                Text("\(done ? "☑" : "☐") \(Text(task.title).strikethrough(done))")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(done ? Color.secondary : Color.primary)
                    .lineLimit(2)
                if showCalendar {
                    Text(task.channelName.map { "#" + $0 } ?? "自分のタスク").font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            Spacer(minLength: 0)
        }
        .fixedSize(horizontal: false, vertical: true)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel((done ? "完了したタスク " : "タスク ") + task.title)
    }
}

// MARK: under a message (L9, docs/REVIEWS.md §2.2)

/// The tasks made from a message, one line each: 「レビュー依頼 · 加納 · 依頼中 · 10/9 まで」 (「タスク · …」 for 「タスクにする」);
/// done grey, past the date red. They come with the message (`MessageOut.tasks`), so the row has its final height from
/// the start (DEVELOPMENT.md §5). A tap opens the task (`MessageSheet.task`).
struct MessageTaskChips: View {
    let tasks: [MessageTaskOut]
    @Bindable var controller: AppController
    /// nil: shown without the tap (a preview).
    var onOpen: ((String) -> Void)?
    var today: DayKey?

    var body: some View {
        let now = today ?? CalendarDates.today()
        VStack(alignment: .leading, spacing: 4) {
            ForEach(tasks) { task in
                let names = task.assigneeIds.map { controller.store.users[$0]?.displayName ?? "?" }
                let chip = TaskRules.chip(task, names: names, today: now)
                Button { onOpen?(task.id) } label: { face(chip, kind: task.kind) }
                    .buttonStyle(.plain)
                    .disabled(onOpen == nil)
                    .accessibilityLabel(chip.text + (chip.tone == .overdue ? "、期限を過ぎています" : ""))
                    .accessibilityHint(onOpen == nil ? "" : "タスクを開く")
            }
        }
        .padding(.top, 2)
    }

    private func face(_ chip: TaskRules.Chip, kind: TaskKind) -> some View {
        let tint: Color = switch chip.tone {
        case .open: .accentColor
        case .overdue: .red
        case .done: .secondary
        }
        let icon = chip.tone == .done ? "checkmark.circle" : kind == .review ? "text.badge.checkmark" : "checklist"
        return HStack(spacing: 5) {
            Image(systemName: icon).font(.caption).foregroundStyle(tint)
            Text(chip.text)
                .font(.caption.weight(.medium))
                .foregroundStyle(chip.tone == .open ? Color.primary : tint)
                .lineLimit(1)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(chip.tone == .overdue ? Color.red.opacity(0.08) : Color.clear, in: RoundedRectangle(cornerRadius: 7))
        .overlay(RoundedRectangle(cornerRadius: 7).strokeBorder(chip.tone == .overdue ? Color.red.opacity(0.55) : Color.secondary.opacity(0.3)))
        .contentShape(Rectangle())
    }
}

/// A chip's task: read (held in a window, else from the server), then its form — where an assignee finds
/// 「対応を始める」 / 「完了にする」.
struct TaskDetailLoader: View {
    @Bindable var controller: AppController
    let taskId: String
    @State private var task: TaskOut?
    @State private var error: String?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ZStack {
            if let task {
                TaskForm(controller: controller, hub: controller.taskHub, target: .task(task))
            } else {
                NavigationStack {
                    VStack(spacing: 12) {
                        if let error {
                            Text(error).font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
                        } else {
                            ProgressView("読み込み中…")
                        }
                    }
                    .padding()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .navigationTitle("タスク")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) { Button("閉じる") { dismiss() } }
                    }
                }
            }
        }
        .task(id: taskId) { await load() }
    }

    private func load() async {
        guard let hub = controller.taskHub, hub.available else {
            error = "接続すると表示します"
            return
        }
        do {
            task = try await hub.load(taskId)
        } catch {
            self.error = controller.describe(error)
        }
    }
}
