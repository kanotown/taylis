import Foundation

/// M56: a task to show (a task's notification) or a board to open (「自分の担当」's channel name).
struct TaskOpen: Equatable {
    /// nil: only the channel's 「タスク」 tab.
    let taskId: String?
    /// nil: my own list (「自分のタスク」 shows it); else that channel's 「タスク」 tab.
    let channelId: String?
}

/// M56: tasks and the screens around them (TASKS.md §6).
extension AppController {
    /// The tasks of the device on screen: the engine's (views under test pass their own).
    var taskHub: TaskHub? { engine?.tasks }

    /// Whether the server has tasks: UserMe carries notify_tasks from M55 on (an older server: no 「タスクにする」).
    var serverHasTasks: Bool { (store.me ?? me)?.notifyTasks != nil }

    /// May I change the board of this channel (or this personal task)?
    func canEditTask(_ task: TaskOut) -> Bool {
        TaskRules.canEditTask(task, channel: task.channelId.flatMap(store.channel), isAdmin: isAdmin)
    }

    func canEditBoard(_ channelId: String) -> Bool {
        TaskRules.canEditBoard(store.channel(channelId), isAdmin: isAdmin)
    }

    /// task.assigned / task.due while the app is open: the push's words in the notice, unless I turned task
    /// notifications off or do not want to be disturbed now (the push is held back then too, TASKS.md §5).
    func sayTaskNotice(_ notice: TaskNotice) {
        let me = store.me ?? self.me
        guard me?.taskNotices ?? true, !DND.isActive(me?.asPublic) else { return }
        switch notice {
        case .assigned(let data):
            self.notice = "☑️ " + TaskRules.noticeText(assigned: data) { [store] id in store.users[id]?.displayName }
        case .due(let data):
            self.notice = "☑️ " + TaskRules.noticeText(due: data)
        case .reviewDone(let data):  // L9
            self.notice = "☑️ " + TaskRules.noticeText(reviewDone: data) { [store] id in store.users[id]?.displayName }
        }
    }

    /// L9: a DM's (or group DM's) task — no board; lists name the other members instead of a channel.
    func isDmTask(_ channelId: String?) -> Bool {
        guard let channelId else { return false }
        return store.channel(channelId)?.channel.isDm ?? false
    }

    /// Where a shared task lives, as 「自分の担当」 / 「自分が依頼した」 name it: the channel's name, or for a DM (whose
    /// `channel_name` is null) the other members' names.
    func taskPlaceName(_ channelId: String, fallback: String?) -> String {
        guard let state = store.channel(channelId) else { return fallback ?? "DM" }
        if state.channel.isDm { return channelTitle(state, store: store) }
        return state.channel.name ?? fallback ?? "?"
    }
}
