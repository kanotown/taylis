import SwiftUI
import XCTest
@testable import ChikuwaChat

/// M56 (TASKS.md §6), light and dark: a channel's 「タスク」 tab (mine to change, and read-only), the task form (a task,
/// a new one from a message, someone else's board), 「タスク」 from the home's tile, and the calendar's task rows. Run with
/// TEST_RUNNER_SNAPSHOT_DIR=<dir> to look at them.
@MainActor
final class TaskSnapshotTests: XCTestCase {
    private typealias F = TaskFixtures
    private let today: DayKey = "2026-10-01"

    override func setUp() { CalendarDates.zoneOverride = TimeZone(identifier: "Asia/Tokyo") }
    override func tearDown() {
        CalendarDates.zoneOverride = nil
        UserDefaults.standard.removeObject(forKey: CalendarView.modeKey)
    }

    private func render<V: View>(_ view: V, size: CGSize = CGSize(width: 393, height: 852), style: UIUserInterfaceStyle, name: String,
                                 settle: TimeInterval = 0.8) throws -> UIImage {
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        let window = scene.map { UIWindow(windowScene: $0) } ?? UIWindow(frame: CGRect(origin: .zero, size: size))
        window.frame = CGRect(origin: .zero, size: size)
        window.overrideUserInterfaceStyle = style
        let host = UIHostingController(rootView: view)
        host.view.backgroundColor = .systemBackground
        window.rootViewController = host
        window.makeKeyAndVisible()
        host.view.frame = window.bounds
        host.view.layoutIfNeeded()
        RunLoop.current.run(until: Date().addingTimeInterval(settle))
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { context in
            if !window.drawHierarchy(in: window.bounds, afterScreenUpdates: true) { window.layer.render(in: context.cgContext) }
        }
        window.isHidden = true
        if let dir = ProcessInfo.processInfo.environment["SNAPSHOT_DIR"], let data = image.pngData() {
            let url = URL(fileURLWithPath: dir).appendingPathComponent(name)
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try data.write(to: url)
            print("snapshot written: \(url.path)")
        }
        return image
    }

    private let labId = "0199a0b0-1111-7000-8000-000000000001"
    private let newsId = "0199a0b0-2222-7000-8000-000000000002"
    private let m2Id = "0199f000-aaaa-7bbb-8ccc-0123456789ab"
    private let people = [("me", "加納"), ("u-ebi", "海老原"), ("u-sato", "佐藤 美咲"), ("u-tanaka", "田中"), ("u-kim", "Kim")]

    private func world() -> (AppController, FakeTaskApi) {
        let controller = AppController()
        let store = controller.store
        var me = UserMe(id: "me", username: "kano", displayName: "加納", role: "member", deactivatedAt: nil, createdAt: "", updatedAt: "", email: nil,
                        mustChangePassword: false)
        me.notifyTasks = true
        store.setMe(me)
        for (id, name) in people {
            store.upsertUser(UserPublic(id: id, username: id, displayName: name, role: "member", deactivatedAt: nil, createdAt: "", updatedAt: ""))
        }
        for (id, name, type, policy) in [(labId, "lab", "public", nil), (m2Id, "m2-進捗", "private", nil), (newsId, "お知らせ", "public", "owners")] {
            var out = ChannelOut(id: id, type: type, name: name, topic: nil, purpose: nil, archived: false, createdBy: nil, lastSeq: 0, lastMessageAt: nil,
                                 createdAt: "", updatedAt: "", membership: MembershipOut(role: "member", joinedAt: ""), dmUserIds: nil)
            out.postingPolicy = policy
            store.upsertChannel(out, isMember: true)
        }
        // L9: a DM with 佐藤 (its tasks have no channel name).
        store.upsertChannel(ChannelOut(id: dmId, type: "dm", name: nil, topic: nil, purpose: nil, archived: false, createdBy: nil, lastSeq: 0,
                                       lastMessageAt: nil, createdAt: "", updatedAt: "", membership: nil, dmUserIds: ["me", "u-sato"]), isMember: true)
        let source = TaskSourceOut(messageId: "m1", channelId: labId, excerpt: "来週のゼミまでに先行研究を 3 本まとめておいてください")
        let board = [
            F.task("先行研究を 3 本まとめる", id: "b1", channelId: labId, notes: "Google Scholar で 2020 年以降", position: 1, dueOn: "2026-09-29",
                   assigneeIds: ["me", "u-ebi"], source: source),
            F.task("実験装置の予約", id: "b2", channelId: labId, position: 2, dueOn: today, assigneeIds: ["u-sato"]),
            F.task("ゼミ発表のスライド (第 2 版)", id: "b3", channelId: labId, position: 3, dueOn: "2026-10-08",
                   assigneeIds: ["me", "u-ebi", "u-sato", "u-tanaka", "u-kim"]),
            F.task("研究室の掃除当番表を作る", id: "b4", channelId: labId, position: 4),
            F.task("データの前処理", id: "b5", channelId: labId, status: .doing, position: 1, dueOn: "2026-10-03", assigneeIds: ["me"]),
            F.task("学会の参加登録", id: "b6", channelId: labId, status: .done, position: 1, completedAt: "2026-09-30T00:00:00Z"),
            F.task("全体連絡: 10 月の予定", id: "n1", channelId: newsId, channelName: "お知らせ", position: 1, dueOn: "2026-10-10", canDelete: false),
            F.task("輪講の担当を決める", id: "n2", channelId: newsId, channelName: "お知らせ", status: .doing, position: 2, canDelete: false),
        ]
        let mine = [
            F.task("図書館に本を返す", id: "p1", channelId: nil, position: 1, dueOn: "2026-09-30"),
            F.task("奨学金の書類", id: "p2", channelId: nil, status: .doing, position: 2, dueOn: "2026-10-06", source: TaskSourceOut(messageId: nil,
                                                                                                                               channelId: labId, excerpt: nil)),
            F.task("健康診断の予約", id: "p3", channelId: nil, position: 3),
            F.task("指導教員に連絡", id: "p4", channelId: nil, status: .done, position: 4, completedAt: "2026-09-29T00:00:00Z"),
            board[0], board[2], board[4],
            F.task("中間発表の練習", id: "m1", channelId: m2Id, channelName: "m2-進捗", position: 1, dueOn: "2026-10-14", assigneeIds: ["me"]),
        ]
        let due = [board[0], board[1], board[2], board[4], board[5], mine[0], mine[1], mine[7],
                   F.task("報告書の提出", id: "d1", channelId: m2Id, channelName: "m2-進捗", status: .done, position: 1, dueOn: today)]
        let api = FakeTaskApi(board: board, mine: mine, due: due)
        api.requested = [  // L9 「自分が依頼した」
            F.task("レビュー: 修論 3 章 (Overleaf)", id: "r1", channelId: dmId, channelName: nil, position: 1, dueOn: "2026-10-09",
                   assigneeIds: ["u-sato"], kind: .review),
            F.task("レビュー: 学会原稿のアブストラクト", id: "r2", channelId: labId, status: .doing, position: 2, dueOn: "2026-09-30",
                   assigneeIds: ["u-ebi", "u-tanaka"], kind: .review),
            F.task("ポスターの印刷", id: "r3", channelId: labId, status: .done, position: 3, assigneeIds: ["u-kim"], completedAt: "2026-09-30T00:00:00Z"),
        ]
        return (controller, api)
    }

    private let dmId = "0199a0b0-3333-7000-8000-000000000003"

    private func hub(_ api: FakeTaskApi) -> TaskHub { TaskHub(api: api, me: { "me" }) }

    private func pane(_ controller: AppController, _ api: FakeTaskApi, channelId: String, column: TaskStatus, title: String) throws -> some View {
        let channel = try XCTUnwrap(controller.store.channel(channelId))
        let hub = hub(api)
        return NavigationStack {
            VStack(spacing: 0) {
                ChannelTabsRow(controller: controller, channel: channel, tab: .constant(.tasks), onAddLink: {}, onEditLink: { _ in })
                ChannelTasksPane(controller: controller, channel: channel, hub: hub, today: today, column: column.rawValue)
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
        }
    }

    func testBoard() throws {
        for style in [UIUserInterfaceStyle.light, .dark] {
            let suffix = style == .dark ? "dark" : "light"
            let (controller, api) = world()
            _ = try render(pane(controller, api, channelId: labId, column: .todo, title: "#lab"), style: style, name: "tasks-board-\(suffix).png")
            XCTAssertEqual(api.listCalls.last?.channelId, labId)
            _ = try render(pane(controller, api, channelId: newsId, column: .todo, title: "#お知らせ"), style: style,
                           name: "tasks-board-readonly-\(suffix).png")
        }
    }

    func testForms() throws {
        for style in [UIUserInterfaceStyle.light, .dark] {
            let suffix = style == .dark ? "dark" : "light"
            let (controller, api) = world()
            let hub = hub(api)
            let members = people.map(\.0)
            _ = try render(TaskForm(controller: controller, hub: hub, target: .task(api.board[0]), memberIds: members, today: today), style: style,
                           name: "tasks-form-edit-\(suffix).png")
            var draft = TaskDraft(title: "来週のゼミまでに先行研究を 3 本まとめておいてください", channelId: labId)
            draft.sourceMessageId = "m1"
            draft.sourceExcerpt = draft.title
            draft.boardChoices = [labId]
            _ = try render(TaskForm(controller: controller, hub: hub, target: .new(draft), memberIds: members, today: today), style: style,
                           name: "tasks-form-new-\(suffix).png")
            _ = try render(TaskForm(controller: controller, hub: hub, target: .task(api.board[6]), memberIds: members, today: today), style: style,
                           name: "tasks-form-readonly-\(suffix).png")
            let picker = NavigationStack {
                TaskAssigneePicker(controller: controller, memberIds: members, selected: .constant(["me", "u-ebi"]))
            }
            _ = try render(picker, style: style, name: "tasks-assignees-\(suffix).png")
        }
    }

    func testMine() throws {
        for style in [UIUserInterfaceStyle.light, .dark] {
            let suffix = style == .dark ? "dark" : "light"
            let (controller, api) = world()
            _ = try render(NavigationStack { MyTasksView(controller: controller, hub: hub(api), today: today, showDone: true) }, style: style,
                           name: "tasks-mine-\(suffix).png")
            XCTAssertEqual(api.mineCalls, 1)
            XCTAssertEqual(api.requestedCalls, 1)
        }
    }

    /// L9 (REVIEWS.md §2.2, §2.3): 「レビューを依頼」 from a DM, a request as its assignee sees it (the big buttons), the
    /// chips under a message.
    func testReviews() throws {
        for style in [UIUserInterfaceStyle.light, .dark] {
            let suffix = style == .dark ? "dark" : "light"
            let (controller, api) = world()
            let hub = hub(api)
            var message = MessageState(placeholderFor: "x", channelId: dmId, senderId: "me", body: "修論 3 章を Overleaf に上げました", createdAt: "")
            message.id = "m9"
            var draft = TaskRules.messageReviewInit(message, channel: controller.store.channel(dmId), users: controller.store.users, groups: [:])
            draft.assigneeIds = ["u-sato"]
            draft.dueOn = "2026-10-09"
            _ = try render(TaskForm(controller: controller, hub: hub, target: .new(draft), memberIds: ["me", "u-sato"], today: today), style: style,
                           name: "reviews-form-new-\(suffix).png")
            let asked = F.task("レビュー: 学会原稿のアブストラクト", id: "q1", channelId: labId, ownerId: "u-ebi", dueOn: "2026-10-09", assigneeIds: ["me"],
                               source: TaskSourceOut(messageId: "m2", channelId: labId, excerpt: "学会原稿のアブストラクト"), kind: .review)
            _ = try render(TaskForm(controller: controller, hub: hub, target: .task(asked), memberIds: people.map(\.0), today: today), style: style,
                           name: "reviews-form-assignee-\(suffix).png")
            let chips = MessageTaskChips(tasks: [
                MessageTaskOut(id: "c1", kind: .review, status: .todo, assigneeIds: ["u-sato"], dueOn: "2026-10-09", ownerId: "me"),
                MessageTaskOut(id: "c2", kind: .review, status: .doing, assigneeIds: ["u-ebi", "u-tanaka", "u-kim"], dueOn: "2026-09-30", ownerId: "me"),
                MessageTaskOut(id: "c3", kind: .review, status: .done, assigneeIds: ["u-sato"], dueOn: "2026-09-20", ownerId: "me"),
                MessageTaskOut(id: "c4", kind: .task, status: .todo, assigneeIds: ["me"], dueOn: today, ownerId: "u-ebi"),
            ], controller: controller, onOpen: { _ in }, today: today)
            _ = try render(VStack(alignment: .leading) { chips; Spacer() }.padding(), size: CGSize(width: 393, height: 240), style: style,
                           name: "reviews-chips-\(suffix).png")
            // 「自分が依頼した」 at the bottom of 「タスク」 (a tall screen to show it).
            _ = try render(NavigationStack { MyTasksView(controller: controller, hub: hub, today: today) }, size: CGSize(width: 393, height: 1500),
                           style: style, name: "reviews-mine-\(suffix).png")
        }
    }

    func testCalendarRows() throws {
        for style in [UIUserInterfaceStyle.light, .dark] {
            let suffix = style == .dark ? "dark" : "light"
            let (controller, api) = world()
            let events = FakeCalendarApi([
                CalendarFixtures.timed("ゼミ", "2026-10-01T05:00:00Z", "2026-10-01T06:30:00Z", channelId: labId, channelName: "lab"),
                CalendarFixtures.allDay("学園祭 (休講)", "2026-10-01", "2026-10-03", channelId: m2Id, channelName: "m2-進捗"),
            ])
            let calendar = CalendarHub(api: events, me: { "me" })
            UserDefaults.standard.set(CalendarView.Mode.list.rawValue, forKey: CalendarView.modeKey)
            _ = try render(NavigationStack { CalendarView(controller: controller, hub: calendar, tasks: hub(api), today: today) }, style: style,
                           name: "tasks-calendar-list-\(suffix).png")
            XCTAssertEqual(api.dueCalls.last?.from, today)
            UserDefaults.standard.set(CalendarView.Mode.month.rawValue, forKey: CalendarView.modeKey)
            _ = try render(NavigationStack { CalendarView(controller: controller, hub: calendar, tasks: hub(api), today: today) }, style: style,
                           name: "tasks-calendar-month-\(suffix).png")
            XCTAssertEqual(api.dueCalls.last?.from, "2026-09-27") // the month's grid, Sunday first
        }
    }

    /// M84 (TASKS.md §11.8): a board with an added column, cards with a time, a checklist and 🔁, the column editor, and
    /// the form's time, repeat and subtasks.
    func testColumnsTimesRepeatsAndSubtasks() throws {
        for style in [UIUserInterfaceStyle.light, .dark] {
            let suffix = style == .dark ? "dark" : "light"
            let (controller, api) = world()
            func column(_ id: String, _ name: String, _ status: TaskStatus, _ builtin: Bool, _ position: Double) -> TaskColumnOut {
                TaskColumnOut(id: id, channelId: labId, name: name, status: status, builtin: builtin, position: position)
            }
            api.columns = [column("k-todo", "未着手", .todo, true, 1), column("k-review", "レビュー待ち", .doing, false, 1.5),
                           column("k-doing", "進行中", .doing, true, 2), column("k-done", "完了", .done, true, 3)]
            api.board[0].dueAt = "2026-10-01T05:00:00Z"
            api.board[0].dueOn = today
            api.board[0].subtasks = [SubtaskOut(id: "s1", title: "Google Scholar で探す", done: true), SubtaskOut(id: "s2", title: "要点を 1 枚に"),
                                     SubtaskOut(id: "s3", title: "ゼミで共有")]
            api.board[0].rrule = "FREQ=WEEKLY;BYDAY=TH"
            api.board[2].subtasks = [SubtaskOut(id: "s4", title: "図", done: true), SubtaskOut(id: "s5", title: "本文", done: true)]
            api.board[4].columnId = "k-review"
            _ = try render(pane(controller, api, channelId: labId, column: .todo, title: "#lab"), style: style, name: "m84-board-\(suffix).png")
            let hub = hub(api)
            Task { await hub.openBoard(labId) }
            _ = try render(TaskColumnsEditor(controller: controller, channelId: labId, hub: hub), style: style, name: "m84-columns-\(suffix).png")
            _ = try render(TaskForm(controller: controller, hub: hub, target: .task(api.board[0]), memberIds: people.map(\.0), today: today),
                           size: CGSize(width: 393, height: 1700), style: style, name: "m84-form-\(suffix).png")
        }
    }
}
