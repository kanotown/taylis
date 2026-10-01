import Foundation

/// M56 (TASKS.md): the tasks' pure rules, the web's ui/tasks.ts — a column's order, the neighbours of 上へ / 下へ, the
/// optimistic move, events, due dates, who may edit a board, 「自分のタスク」's groups, the form's patch, 「タスクにする」's
/// prefill, the in-app notices' wording. No store, no views: the hub (Sync/TaskHub.swift) and the screens share them.
enum TaskRules {
    static let maxTitle = 200
    static let maxNotes = 4000
    /// A board brings this many completed cards (then 「完了をすべて表示」 reads them all).
    static let boardDoneLimit = 100
    /// Avatars on a card before 「+N」.
    static let cardAvatars = 3

    // MARK: order

    /// The server's order inside a column: position, then id.
    static func inOrder(_ a: TaskOut, _ b: TaskOut) -> Bool {
        a.position != b.position ? a.position < b.position : a.id < b.id
    }

    /// One column of a board, in the server's order (never a local index: the server may renumber).
    static func column(_ tasks: [TaskOut], _ status: TaskStatus) -> [TaskOut] {
        tasks.filter { $0.status == status }.sorted(by: inOrder)
    }

    /// Where a card put into slot `index` of `column` lands: the card ending up directly above (afterId) and directly
    /// below (beforeId). `column` may hold the card itself (a move within it); slots run from 0 to column.count.
    static func neighbors(_ column: [TaskOut], moving taskId: String, to index: Int) -> TaskNeighbors {
        let from = column.firstIndex { $0.id == taskId }
        let rest = column.filter { $0.id != taskId }
        var slot = max(0, min(index, column.count))
        if let from, from < slot { slot -= 1 }
        slot = min(slot, rest.count)
        return TaskNeighbors(afterId: slot > 0 ? rest[slot - 1].id : nil, beforeId: slot < rest.count ? rest[slot].id : nil)
    }

    /// 「上へ」 (-1) / 「下へ」 (1) within its column: the neighbours one place up or down (nil at the top / bottom).
    static func moveWithin(_ column: [TaskOut], _ taskId: String, _ direction: Int) -> TaskNeighbors? {
        guard let from = column.firstIndex(where: { $0.id == taskId }) else { return nil }
        let to = from + direction
        guard to >= 0, to < column.count else { return nil }
        return neighbors(column, moving: taskId, to: direction < 0 ? to : to + 1)
    }

    /// The position a move would get here (the optimistic guess; the server's answer replaces it): between the
    /// neighbours, else past the one given, else the bottom of 未着手 / 進行中 and the top of 完了 (the server's rule).
    static func guessPosition(_ tasks: [TaskOut], _ taskId: String, _ status: TaskStatus, _ neighbors: TaskNeighbors) -> Double {
        let column = column(tasks, status).filter { $0.id != taskId }
        let above = column.firstIndex { $0.id == neighbors.afterId }
        let below = column.firstIndex { $0.id == neighbors.beforeId }
        if let above, let below { return (column[above].position + column[below].position) / 2 }
        if let above {
            return above + 1 < column.count ? (column[above].position + column[above + 1].position) / 2 : column[above].position + 1
        }
        if let below {
            return below > 0 ? (column[below - 1].position + column[below].position) / 2 : column[below].position - 1
        }
        guard let first = column.first, let last = column.last else { return 0 }
        return status == .done ? first.position - 1 : last.position + 1
    }

    /// The optimistic move: the card in its new column at its guessed position (completion as the server would set it).
    static func applyLocalMove(_ tasks: [TaskOut], _ taskId: String, _ status: TaskStatus, _ neighbors: TaskNeighbors,
                               now: String = isoNow(), me: String? = nil) -> [TaskOut] {
        guard let task = tasks.first(where: { $0.id == taskId }) else { return tasks }
        let position = guessPosition(tasks, taskId, status, neighbors)
        return tasks.map { item in
            guard item.id == taskId else { return item }
            var moved = item
            moved.position = position
            if status != task.status {
                moved.completedAt = status == .done ? now : nil
                moved.completedBy = status == .done ? me : nil
            }
            moved.status = status
            return moved
        }
    }

    static func isoNow() -> String { ISO8601DateFormatter().string(from: Date()) }

    // MARK: lists and events

    /// A task as it is now (an event, an answer): replaces the one held, or joins the list.
    static func upsert(_ tasks: [TaskOut], _ task: TaskOut) -> [TaskOut] {
        var out = tasks
        if let index = out.firstIndex(where: { $0.id == task.id }) { out[index] = task } else { out.append(task) }
        return out
    }

    static func remove(_ tasks: [TaskOut], _ taskId: String) -> [TaskOut] { tasks.filter { $0.id != taskId } }

    /// task.updated's task: `can_delete` is `deleter_ids` holding me.
    static func fromEvent(_ task: TaskOut, deleterIds: [String], me: String?) -> TaskOut {
        var out = task
        out.canDelete = me.map(deleterIds.contains) ?? false
        return out
    }

    /// In 「自分のタスク」: personal (only I see them) or assigned to me.
    static func isMine(_ task: TaskOut, me: String?) -> Bool {
        task.channelId == nil || (me.map(task.assigneeIds.contains) ?? false)
    }

    /// L9 「自分が依頼した」 (GET /tasks/requested): a shared task I made with someone else assigned.
    static func isRequested(_ task: TaskOut, me: String?) -> Bool {
        guard let me, task.channelId != nil, task.ownerId == me else { return false }
        return task.assigneeIds.contains { $0 != me }
    }

    // MARK: due dates

    static func isOverdue(_ task: TaskOut, today: DayKey) -> Bool {
        guard let due = task.dueOn else { return false }
        return task.status != .done && due < today
    }

    /// A card's due date: 「今日」, else M/D (with the year when not this year's).
    static func dueLabel(_ dueOn: String, today: DayKey) -> String {
        if dueOn == today { return "今日" }
        let parts = dueOn.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return dueOn }
        let md = "\(parts[1])/\(parts[2])"
        return dueOn.prefix(4) == today.prefix(4) ? md : "\(parts[0])/\(md)"
    }

    /// The due date in full, for the form's read-only view: 2026/10/5 (今日).
    static func dueText(_ dueOn: String?, today: DayKey) -> String {
        guard let dueOn else { return "なし" }
        return dueOn.replacingOccurrences(of: "-", with: "/") + (dueOn == today ? " (今日)" : "")
    }

    /// The tasks due on a day (the calendar's rows): open ones first, then by title.
    static func tasksForDay(_ tasks: [TaskOut], _ day: DayKey) -> [TaskOut] {
        tasks.filter { $0.dueOn == day }.sorted { a, b in
            if (a.status == .done) != (b.status == .done) { return b.status == .done }
            let order = a.title.localizedStandardCompare(b.title)
            return order != .orderedSame ? order == .orderedAscending : a.id < b.id
        }
    }

    /// Whether a task is due inside [from, to) (dates; the calendar's window).
    static func dueInRange(_ task: TaskOut, from: DayKey, to: DayKey) -> Bool {
        guard let due = task.dueOn else { return false }
        return from <= due && due < to
    }

    /// The calendar's filter on tasks: 「自分」 is 「自分のタスク」 (personal and assigned to me).
    static func filter(_ tasks: [TaskOut], _ filter: CalendarFilter, me: String?) -> [TaskOut] {
        switch filter {
        case .all: tasks
        case .mine: tasks.filter { isMine($0, me: me) }
        case .channel(let id): tasks.filter { $0.channelId == id }
        }
    }

    // MARK: permissions

    /// Public and private channels have a board; DMs and group DMs do not (TASKS.md §2).
    static func hasBoard(_ channel: ChannelState) -> Bool {
        channel.channel.type == "public" || channel.channel.type == "private"
    }

    /// Whether I may add, change and move a board's cards: the composer's rule (a member, not archived, and in an
    /// announcement channel only owners and admins). The server checks it again (403 posting_restricted, 409 channel_archived).
    static func canEditBoard(_ channel: ChannelState?, isAdmin: Bool) -> Bool {
        guard let channel else { return false }
        return channel.isMember && hasBoard(channel) && !channel.channel.archived && channel.canPostTopLevel(isAdmin: isAdmin)
    }

    /// A task I may change: a personal one always (only I see it), a shared one when I may edit its board, a DM's
    /// (L9) when I am still in that DM.
    static func canEditTask(_ task: TaskOut, channel: ChannelState?, isAdmin: Bool) -> Bool {
        task.channelId == nil || canEditBoard(channel, isAdmin: isAdmin) || canShareInDm(channel)
    }

    /// L9 (REVIEWS.md §2.1): a DM or group DM I am in (not archived) has no board, but a task made from one of its
    /// messages may be shared with its members.
    static func canShareInDm(_ channel: ChannelState?) -> Bool {
        guard let channel else { return false }
        return channel.channel.isDm && channel.isMember && !channel.channel.archived
    }

    /// L9: 「レビューを依頼」 needs a conversation the request can be shared in — a board I may add to, or a DM.
    static func canRequestReview(_ channel: ChannelState?, isAdmin: Bool) -> Bool {
        canEditBoard(channel, isAdmin: isAdmin) || canShareInDm(channel)
    }

    /// Why a board is read-only (or could not be read), as the banner over it says; nil when it is mine to change.
    static func boardNote(_ state: TaskList.State?, channel: ChannelState, canEdit: Bool) -> String? {
        if state == .unsupported { return "このサーバはタスクに対応していません" }
        if state == .failed { return "タスクを読み込めませんでした。下に引いて読み直せます" }
        if canEdit { return nil }
        if channel.channel.archived { return "アーカイブされたチャンネルのタスクは変更できません" }
        if !channel.isMember { return nil }
        return "このボードを変更できるのは、チャンネルのオーナーと管理者だけです"
    }

    // MARK: 「自分のタスク」

    /// Open ones by status (未着手, 進行中) then the server's order; completed ones apart, newest first.
    static func splitOpenDone(_ tasks: [TaskOut]) -> (open: [TaskOut], done: [TaskOut]) {
        let rank: (TaskStatus) -> Int = { TaskStatus.allCases.firstIndex(of: $0) ?? 0 }
        let open = tasks.filter { $0.status != .done }.sorted { a, b in
            rank(a.status) != rank(b.status) ? rank(a.status) < rank(b.status) : inOrder(a, b)
        }
        let done = tasks.filter { $0.status == .done }.sorted { a, b in
            let x = a.completedAt ?? "", y = b.completedAt ?? ""
            return x != y ? x > y : inOrder(a, b)
        }
        return (open, done)
    }

    /// L9 「自分が依頼した」: open ones by date (none last, then oldest first), the server's order; completed ones apart,
    /// newest first.
    static func sortRequested(_ tasks: [TaskOut]) -> (open: [TaskOut], done: [TaskOut]) {
        let open = tasks.filter { $0.status != .done }.sorted { a, b in
            switch (a.dueOn, b.dueOn) {
            case let (x?, y?) where x != y: return x < y
            case (_?, nil): return true
            case (nil, _?): return false
            default: return a.createdAt != b.createdAt ? a.createdAt < b.createdAt : a.id < b.id
            }
        }
        return (open, splitOpenDone(tasks).done)
    }

    struct MineGroup: Equatable {
        let channelId: String
        let channelName: String
        var tasks: [TaskOut]
    }

    /// 「自分のタスク」 (personal) and 「自分の担当」 by channel (channels by name).
    static func groupMine(_ tasks: [TaskOut], me: String?, channelName: (String) -> String? = { _ in nil })
        -> (personal: [TaskOut], groups: [MineGroup]) {
        let personal = tasks.filter { $0.channelId == nil }
        var groups: [MineGroup] = []
        for task in tasks {
            guard let channelId = task.channelId, let me, task.assigneeIds.contains(me) else { continue }
            if let index = groups.firstIndex(where: { $0.channelId == channelId }) {
                groups[index].tasks.append(task)
            } else {
                groups.append(MineGroup(channelId: channelId, channelName: channelName(channelId) ?? task.channelName ?? "?", tasks: [task]))
            }
        }
        groups.sort { $0.channelName.localizedStandardCompare($1.channelName) == .orderedAscending }
        return (personal, groups)
    }

    // MARK: the form

    /// The title as the server keeps it (whitespace collapsed).
    static func cleanTitle(_ title: String) -> String {
        title.split(whereSeparator: { $0.isWhitespace || $0.isNewline }).joined(separator: " ")
    }

    /// What the source says of the message a task came from (§8 1.).
    enum SourceState: Equatable {
        case none, deleted
        case link(messageId: String, excerpt: String?)
    }

    static func sourceState(_ source: TaskSourceOut?) -> SourceState {
        guard let source else { return .none }
        guard let messageId = source.messageId else { return .deleted }
        return .link(messageId: messageId, excerpt: source.excerpt)
    }

    /// 「タスクにする」 (TASKS.md §6): the message's one-line text (the notifications' and the DM list's rule, cut to the
    /// title's 200) as the title, the message as the source, and its channel's board — or 「自分のタスク」 for a DM, a
    /// group DM, or a board I may not add to.
    static func messageTaskInit(_ message: MessageState, channel: ChannelState?, users: [String: UserPublic], groups: [String: GroupOut],
                                isAdmin: Bool) -> TaskDraft {
        let title = Timeline.excerpt(message.body, attachments: message.attachments, users: users, groups: groups, limit: maxTitle)
        let board = canEditBoard(channel, isAdmin: isAdmin) ? channel?.id : nil
        var draft = TaskDraft(title: title, channelId: board)
        draft.sourceMessageId = message.id
        draft.sourceExcerpt = title.isEmpty ? nil : title
        draft.boardChoices = board.map { [$0] } ?? []
        // L9 (REVIEWS.md §2.1): from a DM, choosing assignees shares it in the DM; without, it stays mine.
        if canShareInDm(channel) { draft.dmChannelId = channel?.id }
        return draft
    }

    static let reviewPrefix = "レビュー: "

    /// L9 「レビューを依頼」 (REVIEWS.md §2.3): 「タスクにする」's form as a review request — 「レビュー: <excerpt>」, the
    /// message's own conversation (a channel's board or the DM; the menu offers it only there), 依頼先 to choose (at
    /// least one), no status (it starts 依頼中).
    static func messageReviewInit(_ message: MessageState, channel: ChannelState?, users: [String: UserPublic], groups: [String: GroupOut]) -> TaskDraft {
        let excerpt = Timeline.excerpt(message.body, attachments: message.attachments, users: users, groups: groups, limit: maxTitle)
        var draft = TaskDraft(title: String((reviewPrefix + excerpt).prefix(maxTitle)), channelId: channel?.id)
        draft.kind = .review
        draft.needsAssignee = true
        draft.sourceMessageId = message.id
        draft.sourceExcerpt = excerpt.isEmpty ? nil : excerpt
        draft.boardChoices = channel.map { [$0.id] } ?? []
        return draft
    }

    // MARK: the chip under a message (L9, REVIEWS.md §2.2)

    /// 「レビュー依頼」 / 「タスク」.
    static func kindLabel(_ kind: TaskKind) -> String { kind == .review ? "レビュー依頼" : "タスク" }

    /// A review request's state reads 依頼中 / 対応中 / 完了; a task's the columns' 未着手 / 進行中 / 完了.
    static func statusLabel(_ status: TaskStatus, kind: TaskKind) -> String {
        guard kind == .review else { return status.label }
        switch status {
        case .todo: return "依頼中"
        case .doing: return "対応中"
        case .done: return "完了"
        }
    }

    /// The assignees on one line: two names, then 「他 N 人」.
    static func namesText(_ names: [String]) -> String {
        guard names.count > 2 else { return names.joined(separator: "、") }
        return names.prefix(2).joined(separator: "、") + " 他 \(names.count - 2) 人"
    }

    struct Chip: Equatable {
        enum Tone: Equatable {
            case open
            /// Past its date and not done: red.
            case overdue
            /// Grey.
            case done
        }

        let text: String
        let tone: Tone
    }

    /// 「レビュー依頼 · 加納 · 依頼中 · 10/9 まで」: the kind, the assignees (left out when none), the state, the date (left
    /// out when none or done; 「今日まで」 on the day). Done is grey, past the date and not done red.
    static func chip(_ task: MessageTaskOut, names: [String], today: DayKey) -> Chip {
        var parts = [kindLabel(task.kind)]
        if !names.isEmpty { parts.append(namesText(names)) }
        parts.append(statusLabel(task.status, kind: task.kind))
        let done = task.status == .done
        if let due = task.dueOn, !done { parts.append(due == today ? "今日まで" : dueLabel(due, today: today) + " まで") }
        let overdue = !done && (task.dueOn.map { $0 < today } ?? false)
        return Chip(text: parts.joined(separator: " · "), tone: done ? .done : overdue ? .overdue : .open)
    }

    // MARK: notices

    /// The open app's line for task.assigned / task.due, the push's wording (§5): 「<name> がタスクを割り当てました: <title>
    /// (#<channel>)」 / 「今日が期限: <title>」 (+ 「 (#<channel>)」 for a shared one).
    /// L9: a review request says 「レビューを依頼しました」; a DM's task (its name empty) has no 「(#…)」.
    static func noticeText(assigned: TaskAssigned, nameOf: (String) -> String?) -> String {
        let verb = assigned.kind == .review ? "レビューを依頼しました" : "タスクを割り当てました"
        return "\(nameOf(assigned.byUserId) ?? "メンバー") が\(verb): \(assigned.title)\(whereText(assigned.channelName))"
    }

    static func noticeText(due: TaskDue) -> String {
        "今日が期限: \(due.title)\(due.channelId != nil ? whereText(due.channelName) : "")"
    }

    /// L9 task.review_done: 「<name> がレビューを完了しました: <title> (#<channel>)」.
    static func noticeText(reviewDone: TaskReviewDone, nameOf: (String) -> String?) -> String {
        "\(nameOf(reviewDone.byUserId) ?? "メンバー") がレビューを完了しました: \(reviewDone.title)\(whereText(reviewDone.channelName))"
    }

    /// 「 (#lab)」, nothing for a DM (no name) — the push's rule.
    private static func whereText(_ channelName: String?) -> String {
        guard let channelName, !channelName.isEmpty else { return "" }
        return " (#\(channelName))"
    }
}

/// What the task form holds: the fields as edited, and for a new task where it goes and what it came from.
struct TaskDraft: Equatable {
    var title = ""
    var notes = ""
    var status: TaskStatus = .todo
    /// "" without a due date.
    var dueOn = ""
    var assigneeIds: [String] = []
    /// New: the board (nil: 「自分のタスク」).
    var channelId: String?
    /// 「タスクにする」: the message and its one-line excerpt.
    var sourceMessageId: String?
    var sourceExcerpt: String?
    /// The boards offered besides 「自分のタスク」 (a channel message: its channel's; none from a DM).
    var boardChoices: [String] = []
    /// L9: 「レビューを依頼」 (the form says 依頼先 and 希望日).
    var kind: TaskKind = .task
    /// L9 (REVIEWS.md §2.1): 「タスクにする」 from a DM — with assignees the task is shared in this DM, without it is mine.
    var dmChannelId: String?
    /// L9: a new review request needs someone to ask.
    var needsAssignee = false

    init(title: String = "", channelId: String? = nil, status: TaskStatus = .todo) {
        self.title = title
        self.channelId = channelId
        self.status = status
    }

    init(task: TaskOut) {
        title = task.title
        notes = task.notes ?? ""
        status = task.status
        dueOn = task.dueOn ?? ""
        assigneeIds = task.assigneeIds
        channelId = task.channelId
        kind = task.kind
    }

    /// Where a new task goes: the board chosen, else the DM when someone is assigned (L9), else 「自分のタスク」.
    var target: String? { channelId ?? (assigneeIds.isEmpty ? nil : dmChannelId) }

    var problem: String? {
        let title = TaskRules.cleanTitle(title)
        if needsAssignee && assigneeIds.isEmpty { return "依頼先を選んでください" }
        if title.isEmpty { return "題名を入れてください" }
        if title.count > TaskRules.maxTitle { return "題名は \(TaskRules.maxTitle) 文字までです" }
        if notes.count > TaskRules.maxNotes { return "メモは \(TaskRules.maxNotes) 文字までです" }
        return nil
    }

    /// POST /tasks.
    func create(clientTaskId: String, tz: String) -> TaskCreate {
        var seen = Set<String>()
        let target = target
        let assignees = target == nil ? [] : assigneeIds.filter { seen.insert($0).inserted }
        return TaskCreate(channelId: target, title: TaskRules.cleanTitle(title),
                          notes: notes.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : notes, status: status,
                          dueOn: dueOn.isEmpty ? nil : dueOn, assigneeIds: assignees, sourceMessageId: sourceMessageId,
                          clientTaskId: clientTaskId, tz: tz, kind: kind)
    }

    /// PATCH /tasks/{id} with only what changed (`tz` with a new due date: its notification is read in my zone).
    func patch(from task: TaskOut, tz: String) -> TaskPatch {
        var patch = TaskPatch()
        let title = TaskRules.cleanTitle(self.title)
        if title != task.title { patch.title = title }
        let notes: String? = self.notes.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : self.notes
        if notes != task.notes { patch.notes = .some(notes) }
        if status != task.status { patch.status = status }
        let due: String? = dueOn.isEmpty ? nil : dueOn
        if due != task.dueOn {
            patch.dueOn = .some(due)
            patch.tz = tz
        }
        if task.channelId != nil {
            let before = task.assigneeIds.sorted()
            let after = Array(Set(assigneeIds)).sorted()
            if before != after { patch.assigneeIds = after }
        }
        return patch
    }
}
