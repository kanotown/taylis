import SwiftUI

/// The colours of ○ △ × (the web's MARK_TONE).
extension SchedulePoll.Answer {
    var tone: Color {
        switch self {
        case .yes: .green
        case .maybe: .orange
        case .no: .secondary
        }
    }
}

/// 「○ 2 · △ 0 · × 1」, the marks in their colours.
struct ScheduleCountLine: View {
    let counts: SchedulePoll.Counts
    /// The table's 「○3 △1 ×0」 (a column is narrow).
    var compact = false

    var body: some View {
        let text = compact
            ? Text("○").foregroundColor(.green) + Text("\(counts.yes) ") + Text("△").foregroundColor(.orange) + Text("\(counts.maybe) ×\(counts.no)")
            : Text("○").foregroundColor(.green) + Text(" \(counts.yes) · ") + Text("△").foregroundColor(.orange) + Text(" \(counts.maybe) · × \(counts.no)")
        text
            .font(compact ? .caption2 : .caption)
            .lineLimit(1)
            .monospacedDigit()
            .foregroundStyle(.secondary)
            .accessibilityLabel(SchedulePoll.countsLabel(counts))
    }
}

/// A scheduling poll under its message (M54, SCHEDULING.md §5; the web's ScheduleCard): per candidate the ○ △ × counts
/// and my three buttons (pressing mine again takes it back), the candidate with the most ○ starred, my comment,
/// 「表で見る」 (people × candidates), and for its author, the channel's owners and administrators 「決める」 after asking.
/// Once decided the card shows the decided candidate large, with 「予定を開く」 (the event the decision made) and
/// 「決定を取り消す」.
struct ScheduleCardView: View {
    let poll: PollOut
    let message: MessageState
    @Bindable var controller: AppController
    var readOnly = false

    @State private var comment = ""
    @State private var showTable = false
    @State private var confirmIndex: Int?
    /// The decision the server refused for want of the event (403 posting_restricted): offered again without it.
    @State private var withoutEvent: Int?
    @State private var eventForm: CalendarFormTarget?

    private var me: String? { controller.store.me?.id }
    private var mine: [SchedulePoll.Answer?] { SchedulePoll.myAnswers(poll, me: me) }
    private var myComment: String { SchedulePoll.myComment(poll, me: me) }
    private var closed: Bool { poll.closedAt != nil || poll.decided != nil }
    private var disabled: Bool { readOnly || closed || message.pending }
    private var channel: ChannelState? { controller.store.channel(message.channelId) }
    private var isDm: Bool { channel?.channel.type == "dm" || channel?.channel.type == "group_dm" }

    /// Who may decide (SCHEDULING.md §1): the poll's author, the channel's owners, administrators.
    static func canDecide(_ message: MessageState, controller: AppController) -> Bool {
        guard let me = controller.store.me?.id else { return false }
        return message.senderId == me || controller.isAdmin || controller.store.channel(message.channelId)?.channel.membership?.role == "owner"
    }

    private var decider: Bool { !readOnly && !message.pending && Self.canDecide(message, controller: controller) }

    var body: some View {
        let counts = SchedulePoll.counts(poll)
        let best = Set(SchedulePoll.bestSlots(poll))
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Text("📅 " + poll.question).font(.subheadline.weight(.semibold))
                Text("日程調整").font(.caption2).foregroundStyle(.secondary)
                if poll.isAnonymous { Label("匿名", systemImage: "eye.slash").font(.caption2).foregroundStyle(.secondary) }
            }
            if let decided = poll.decided, decided.index < poll.options.count {
                decidedBlock(decided, counts: counts[decided.index])
            }
            ForEach(Array(poll.options.enumerated()), id: \.offset) { index, label in
                slotRow(index, label: label, counts: counts[index], best: best.contains(index))
            }
            if !readOnly && (!disabled || !myComment.isEmpty) {
                commentField
            }
            HStack {
                Text(footer).font(.caption).foregroundStyle(.secondary)
                Spacer()
                Button { showTable = true } label: { Label("表で見る", systemImage: "tablecells").font(.caption) }
                    .buttonStyle(.borderless)
                    .frame(minHeight: 32)
            }
        }
        .padding(10)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.secondary.opacity(0.2)))
        .padding(.top, 4)
        .onChange(of: myComment, initial: true) { _, value in comment = value }
        .sheet(isPresented: $showTable) {
            ScheduleTableView(poll: poll, message: message, controller: controller, readOnly: readOnly)
        }
        .confirmationDialog("この日に決めますか？", isPresented: Binding(get: { confirmIndex != nil }, set: { if !$0 { confirmIndex = nil } }),
                            titleVisibility: .visible, presenting: confirmIndex) { index in
            Button("決定") { decide(index, createEvent: true) }
            Button("キャンセル", role: .cancel) {}
        } message: { index in
            Text(confirmText(index))
        }
        .alert("予定を作れません", isPresented: Binding(get: { withoutEvent != nil }, set: { if !$0 { withoutEvent = nil } }),
               presenting: withoutEvent) { index in
            Button("予定を作らずに決定") { decide(index, createEvent: false) }
            Button("キャンセル", role: .cancel) {}
        } message: { _ in
            Text("このチャンネルのカレンダーに予定を追加できるのはオーナーと管理者だけです。予定を作らずに決めますか？ (スレッドでは知らせます)")
        }
        .fullScreenCover(item: $eventForm) { target in
            CalendarEventForm(controller: controller, hub: controller.calendarHub, target: target)
        }
    }

    private var footer: String {
        let count = SchedulePoll.respondentCount(poll)
        if poll.decided != nil { return "決定済み · \(count) 人が回答" }
        if poll.closedAt != nil { return "締め切りました · \(count) 人が回答" }
        return "\(count) 人が回答"
    }

    private func confirmText(_ index: Int) -> String {
        let label = index < poll.options.count ? poll.options[index] : ""
        let what = isDm ? "スレッドで回答した人に知らせます。" : "チャンネルのカレンダーに予定を作り、スレッドで回答した人に知らせます。"
        return "\(label)\n\(what)回答は締め切られます (取り消すと再開します)。"
    }

    private func decide(_ index: Int, createEvent: Bool) {
        confirmIndex = nil
        withoutEvent = nil
        Task {
            if await controller.decideSchedule(message, index: index, createEvent: createEvent) == .eventRefused {
                withoutEvent = index
            }
        }
    }

    // MARK: parts

    private func decidedBlock(_ decided: PollDecidedOut, counts: SchedulePoll.Counts) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Label("決定", systemImage: "calendar.badge.checkmark").font(.caption.weight(.semibold)).foregroundStyle(Color.accentColor)
            Text(poll.options[decided.index]).font(.title3.weight(.semibold))
            ScheduleCountLine(counts: counts)
            HStack(spacing: 12) {
                if let eventId = decided.eventId {
                    Button {
                        Task { if let event = await controller.loadCalendarEvent(eventId) { eventForm = .event(event) } }
                    } label: {
                        Label("予定を開く", systemImage: "calendar").font(.subheadline)
                    }
                    .buttonStyle(.borderless)
                }
                Spacer()
                if decider {
                    Button("決定を取り消す") { Task { _ = await controller.undecideSchedule(message) } }
                        .font(.subheadline)
                        .buttonStyle(.borderless)
                }
            }
            .frame(minHeight: 32)
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.accentColor.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.accentColor.opacity(0.45)))
    }

    private func slotRow(_ index: Int, label: String, counts: SchedulePoll.Counts, best: Bool) -> some View {
        let chosen = poll.decided?.index == index
        let current = index < mine.count ? mine[index] : nil
        return VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 4) {
                if best {
                    Image(systemName: "star.fill").font(.caption).foregroundStyle(.yellow)
                        .accessibilityLabel("○ がいちばん多い")
                }
                Text(label).font(.subheadline).lineLimit(1).minimumScaleFactor(0.85)
                Spacer(minLength: 6)
                ScheduleCountLine(counts: counts)
            }
            HStack(spacing: 6) {
                ForEach(SchedulePoll.Answer.allCases, id: \.self) { answer in
                    answerButton(answer, on: current == answer, label: label) {
                        Task { _ = await controller.answerSchedule(message, answers: SchedulePoll.press(mine, index: index, answer: answer)) }
                    }
                }
                Spacer()
                if decider && poll.decided == nil {
                    Button("決める") { confirmIndex = index }
                        .font(.subheadline.weight(.medium))
                        .buttonStyle(.borderless)
                        .frame(minHeight: 32)
                        .accessibilityLabel("\(label) に決める")
                }
            }
        }
        .padding(8)
        .background(Color(.tertiarySystemBackground), in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(chosen ? Color.accentColor : Color.clear, lineWidth: 1.5))
        .opacity(poll.decided != nil && !chosen ? 0.6 : 1)
    }

    private func answerButton(_ answer: SchedulePoll.Answer, on: Bool, label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(answer.mark)
                .font(.body.weight(.semibold))
                .foregroundStyle(on ? Color.white : answer.tone)
                .frame(width: 44, height: 32)
                .background(on ? Color.accentColor : Color.clear, in: RoundedRectangle(cornerRadius: 7))
                .overlay(RoundedRectangle(cornerRadius: 7).stroke(on ? Color.accentColor : Color.secondary.opacity(0.35)))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .opacity(disabled && !on ? 0.5 : 1)
        .accessibilityLabel("\(label): \(answer.name)")
        .accessibilityAddTraits(on ? .isSelected : [])
    }

    private var commentField: some View {
        HStack(spacing: 6) {
            TextField("ひとこと (例: 午後なら参加できます)", text: $comment)
                .font(.subheadline)
                .textFieldStyle(.roundedBorder)
                .disabled(disabled)
                .submitLabel(.done)
                .onSubmit(saveComment)
                .onChange(of: comment) { _, value in
                    if value.count > SchedulePoll.maxComment { comment = String(value.prefix(SchedulePoll.maxComment)) }
                }
                .accessibilityLabel("ひとこと")
            if commentChanged && !disabled {
                Button("保存", action: saveComment).buttonStyle(.borderedProminent).controlSize(.small)
            }
        }
    }

    private var commentChanged: Bool { comment.trimmingCharacters(in: .whitespacesAndNewlines) != myComment }

    private func saveComment() {
        guard commentChanged, !disabled else { return }
        let text = comment.trimmingCharacters(in: .whitespacesAndNewlines)
        Task { _ = await controller.answerSchedule(message, answers: mine, comment: text) }
    }
}

/// 「表で見る」 (M54; the web's ScheduleTableDialog): people × candidates like 調整さん — the counts first, then my row (a
/// cell goes ○ → △ → × → unanswered), then each person's ○ △ × and comment, in the order they first answered. The names
/// stay at the left while the candidates scroll sideways. An anonymous poll has the counts, my row and the comments
/// unnamed.
struct ScheduleTableView: View {
    let poll: PollOut
    let message: MessageState
    @Bindable var controller: AppController
    var readOnly = false
    @Environment(\.dismiss) private var dismiss

    private static let nameWidth: CGFloat = 104
    private static let columnWidth: CGFloat = 78
    private static let commentWidth: CGFloat = 170
    private static let headerHeight: CGFloat = 56
    private static let rowHeight: CGFloat = 44

    private var me: String? { controller.store.me?.id }
    private var mine: [SchedulePoll.Answer?] { SchedulePoll.myAnswers(poll, me: me) }
    private var editable: Bool { !readOnly && poll.closedAt == nil && poll.decided == nil && !message.pending }
    private var people: [String] { poll.isAnonymous ? [] : (poll.respondents ?? []).filter { $0 != me } }

    private func name(_ userId: String) -> String { controller.store.users[userId]?.displayName ?? "?" }
    private func comment(of userId: String) -> String { poll.comments?.first { $0.userId == userId }?.text ?? "" }

    var body: some View {
        NavigationStack {
            ScrollView(.vertical) {
                VStack(alignment: .leading, spacing: 16) {
                    table
                    if poll.isAnonymous, let comments = poll.comments, !comments.isEmpty {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("コメント (匿名)").font(.caption.weight(.medium)).foregroundStyle(.secondary)
                            ForEach(Array(comments.enumerated()), id: \.offset) { _, comment in
                                Text("・" + comment.text).font(.subheadline)
                            }
                        }
                    }
                    if !poll.isAnonymous && people.isEmpty {
                        Text("まだ誰も答えていません").font(.subheadline).foregroundStyle(.secondary)
                    }
                }
                .padding(16)
            }
            .navigationTitle(poll.question)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("閉じる") { dismiss() } }
            }
        }
    }

    private var table: some View {
        let counts = SchedulePoll.counts(poll)
        let best = Set(SchedulePoll.bestSlots(poll))
        return HStack(alignment: .top, spacing: 0) {
            // The names, fixed.
            VStack(alignment: .leading, spacing: 0) {
                nameCell(Text("名前").font(.caption.weight(.medium)).foregroundStyle(.secondary), height: Self.headerHeight)
                nameCell(Text("集計").font(.caption.weight(.medium)).foregroundStyle(.secondary), height: Self.rowHeight)
                if let me {
                    nameCell(Text("\(name(me)) (自分)").font(.subheadline.weight(.medium)), height: Self.rowHeight, mine: true)
                }
                ForEach(people, id: \.self) { userId in
                    nameCell(Text(name(userId)).font(.subheadline), height: Self.rowHeight)
                }
            }
            .frame(width: Self.nameWidth)
            ScrollView(.horizontal, showsIndicators: true) {
                VStack(alignment: .leading, spacing: 0) {
                    row(height: Self.headerHeight) {
                        ForEach(Array(poll.options.enumerated()), id: \.offset) { index, label in
                            HStack(alignment: .top, spacing: 2) {
                                if best.contains(index) {
                                    Image(systemName: "star.fill").font(.system(size: 9)).foregroundStyle(.yellow).padding(.top, 3)
                                        .accessibilityLabel("○ がいちばん多い")
                                }
                                Text(label.replacingOccurrences(of: ") ", with: ")\n")).font(.caption2.weight(.medium))
                                    .multilineTextAlignment(.center).lineLimit(3)
                            }
                            .frame(width: Self.columnWidth, height: Self.headerHeight)
                            .background(poll.decided?.index == index ? Color.accentColor.opacity(0.15) : Color.clear)
                        }
                        Text("コメント").font(.caption.weight(.medium)).foregroundStyle(.secondary)
                            .frame(width: Self.commentWidth, alignment: .leading).padding(.leading, 8)
                    }
                    row(height: Self.rowHeight) {
                        ForEach(counts.indices, id: \.self) { index in
                            ScheduleCountLine(counts: counts[index], compact: true).frame(width: Self.columnWidth)
                        }
                        Color.clear.frame(width: Self.commentWidth + 8)
                    }
                    if me != nil {
                        row(height: Self.rowHeight, mine: true) {
                            ForEach(poll.options.indices, id: \.self) { index in
                                myCell(index, label: poll.options[index]).frame(width: Self.columnWidth)
                            }
                            Text(SchedulePoll.myComment(poll, me: me)).font(.caption).lineLimit(2)
                                .frame(width: Self.commentWidth, alignment: .leading).padding(.leading, 8)
                        }
                    }
                    ForEach(people, id: \.self) { userId in
                        row(height: Self.rowHeight) {
                            ForEach(poll.options.indices, id: \.self) { index in
                                mark(SchedulePoll.answer(of: userId, index, in: poll)).frame(width: Self.columnWidth)
                            }
                            Text(comment(of: userId)).font(.caption).lineLimit(2)
                                .frame(width: Self.commentWidth, alignment: .leading).padding(.leading, 8)
                        }
                    }
                }
            }
            .accessibilityLabel("回答の表")
        }
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.secondary.opacity(0.25)))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    private func nameCell(_ text: some View, height: CGFloat, mine: Bool = false) -> some View {
        text.lineLimit(2)
            .frame(width: Self.nameWidth - 12, height: height, alignment: .leading)
            .padding(.leading, 12)
            .background(mine ? Color.accentColor.opacity(0.08) : Color.clear)
            .overlay(alignment: .bottom) { Rectangle().fill(Color(.separator)).frame(height: 0.5) }
            .overlay(alignment: .trailing) { Rectangle().fill(Color(.separator)).frame(width: 0.5) }
    }

    private func row<Content: View>(height: CGFloat, mine: Bool = false, @ViewBuilder _ content: () -> Content) -> some View {
        HStack(spacing: 0) { content() }
            .frame(height: height)
            .background(mine ? Color.accentColor.opacity(0.08) : Color.clear)
            .overlay(alignment: .bottom) { Rectangle().fill(Color(.separator)).frame(height: 0.5) }
    }

    @ViewBuilder
    private func mark(_ answer: SchedulePoll.Answer?) -> some View {
        if let answer {
            Text(answer.mark).font(.body.weight(.semibold)).foregroundStyle(answer.tone).accessibilityLabel(answer.name)
        } else {
            Text("-").foregroundStyle(.tertiary).accessibilityLabel("未回答")
        }
    }

    @ViewBuilder
    private func myCell(_ index: Int, label: String) -> some View {
        let current = index < mine.count ? mine[index] : nil
        if editable {
            Button {
                let next = mine.enumerated().map { i, value in i == index ? SchedulePoll.Answer.next(after: value) : value }
                Task { _ = await controller.answerSchedule(message, answers: next) }
            } label: {
                mark(current)
                    .frame(width: 40, height: 30)
                    .background(Color(.systemBackground), in: RoundedRectangle(cornerRadius: 6))
                    .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color.secondary.opacity(0.35)))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("自分の \(label): \(current?.name ?? "未回答") (押すと変わります)")
        } else {
            mark(current)
        }
    }
}
