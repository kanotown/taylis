import SwiftUI

/// M86 (docs/DEADLINES.md §8 2.): the conversation header's deadline — one slim row over the tabs (the navigation bar
/// keeps the name and the topic alone: it was too crowded once) with the channel's next open deadline,
/// 「⏰ 全国大会 原稿 あと 3 日」: red today and tomorrow, amber within a week, grey later. A long title is cut, the 「あと N 日」
/// never is. Nothing at all without one, or on a server without deadlines. A tap opens the deadline.
struct DeadlineChipRow: View {
    @Bindable var controller: AppController
    let channel: ChannelState
    /// Tests pass their own hub and day.
    var hub: TaskHub? = nil
    var today: DayKey? = nil
    let onOpen: (TaskOut) -> Void

    private var taskHub: TaskHub? { hub ?? controller.taskHub }

    var body: some View {
        let day = today ?? CalendarDates.today()
        let list = taskHub?.deadlines
        let next = list?.state == .unsupported ? nil : DeadlineRules.next(list?.tasks ?? [], channelId: channel.id, today: day)
        // A stack even when empty: the read below needs a view on screen (an empty Group has none).
        VStack(spacing: 0) {
            if let next {
                HStack(spacing: 0) {
                    DeadlineChip(task: next, today: day) { onOpen(next) }
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 4)
                Divider()
            }
        }
        .task(id: channel.id) {
            guard TaskRules.hasBoard(channel), channel.isMember else { return }
            await taskHub?.openDeadlines()
        }
    }
}

/// The chip itself: ⏰, the title (cut when long), when.
struct DeadlineChip: View {
    let task: TaskOut
    let today: DayKey
    let action: () -> Void

    var body: some View {
        let tone = DeadlineRules.tone(task, today: today)
        let tint: Color = switch tone {
        case .soon: .red
        case .week: .orange
        case .later: .secondary
        }
        Button(action: action) {
            HStack(spacing: 4) {
                Image(systemName: "alarm").font(.caption.weight(.semibold))
                Text(task.title).lineLimit(1).truncationMode(.tail)
                Text(DeadlineRules.remainingText(task, today: today)).fixedSize().monospacedDigit()
            }
            .font(.caption.weight(.semibold))
            .foregroundStyle(tone == .later ? Color.primary : tint)
            .padding(.horizontal, 9)
            .padding(.vertical, 4)
            .background(tint.opacity(tone == .later ? 0.12 : 0.14), in: Capsule())
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(tr("締切：") + DeadlineRules.chipText(task, today: today))
        .accessibilityHint("締切を開く")
    }
}

/// M86 (DEADLINES.md §8 3.): 「締切」 from the home's tile — the deadlines of every channel I am in, 今週 / 今月 / それ以降 /
/// 過ぎたもの (done ones too, the most recent first; an empty group is left out). A row says when (「10/9 (金)」, 「今日 17:00」),
/// the title (struck through once done), the channel and the assignees, and opens the deadline over this list. ＋ adds one
/// to a channel I may (the first by name, changed in the form).
struct DeadlinesView: View {
    static let selectionId = "deadlines"

    @Bindable var controller: AppController
    /// Tests pass their own hub and day.
    var hub: TaskHub? = nil
    var today: DayKey? = nil
    @State private var form: TaskFormTarget?

    private var taskHub: TaskHub? { hub ?? controller.taskHub }

    var body: some View {
        let day = today ?? CalendarDates.today()
        let hub = taskHub
        let list = hub?.deadlines
        let groups = DeadlineRules.groups(list?.tasks ?? [], today: day)
        let boards = controller.deadlineBoards
        List {
            if hub == nil {
                Section { Text("接続すると表示します").foregroundStyle(.secondary) }
            } else if list?.state == .unsupported {
                Section {
                    Text("このサーバは締切に対応していません").foregroundStyle(.secondary)
                }
            } else {
                if list?.state == .failed {
                    Section { Text("締切を読み込めませんでした。下に引いて読み直せます").font(.footnote).foregroundStyle(.secondary) }
                }
                if groups.isEmpty && list?.state != .failed {
                    Section {
                        Text(list == nil || list?.state == .loading ? "読み込み中…" : "締切はありません")
                            .font(.subheadline).foregroundStyle(.secondary)
                    } footer: {
                        if list?.state == .ready && !boards.isEmpty { Text("右上の ＋ か、チャンネルの「タスク」から締切を追加できます") }
                    }
                }
                ForEach(groups, id: \.key) { group in
                    Section(group.label) {
                        ForEach(group.tasks) { task in
                            Button { form = .task(task) } label: { row(task, today: day) }
                                .buttonStyle(.plain)
                        }
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("締切")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { form = .new(TaskDraft.newDeadline(boards: boards)) } label: { Image(systemName: "plus") }
                    .accessibilityLabel("締切を追加")
                    .disabled(hub?.available != true || boards.isEmpty || list?.state == .unsupported)
            }
        }
        .refreshable { await taskHub?.reloadDeadlines() }
        .task { await taskHub?.openDeadlines() }
        .fullScreenCover(item: $form) { target in
            TaskForm(controller: controller, hub: taskHub, target: target)
        }
    }

    private func row(_ task: TaskOut, today: DayKey) -> some View {
        let done = task.status == .done
        let over = DeadlineRules.passed(task, today: today)
        let tone = DeadlineRules.tone(task, today: today)
        let dateColor: Color = done || over ? .secondary : tone == .soon ? .red : tone == .week ? .orange : .secondary
        return HStack(alignment: .top, spacing: 10) {
            Image(systemName: done ? "checkmark.circle" : "alarm")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(done || over ? Color.secondary : tone == .soon ? Color.red : Color.orange)
                .frame(width: 20)
                .padding(.top, 1)
            VStack(alignment: .leading, spacing: 3) {
                Text(DeadlineRules.when(task, today: today))
                    .font(.caption.weight(.semibold))
                    .monospacedDigit()
                    .foregroundStyle(dateColor)
                Text(task.title)
                    .font(.subheadline)
                    .strikethrough(done)
                    .foregroundStyle(done ? Color.secondary : Color.primary)
                    .multilineTextAlignment(.leading)
                Text(place(task) + (done ? tr(" · 完了") : task.status == .doing ? tr(" · 進行中") : ""))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
            TaskAssigneeStack(controller: controller, ids: task.assigneeIds)
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityHint("締切を開く")
    }

    private func place(_ task: TaskOut) -> String {
        guard let channelId = task.channelId else { return "" }
        let glyph = controller.store.channel(channelId)?.channel.type == "private" ? "🔒 " : "#"
        return glyph + controller.taskPlaceName(channelId, fallback: task.channelName)
    }
}
