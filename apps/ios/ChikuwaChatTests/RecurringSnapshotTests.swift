import SwiftUI
import XCTest
@testable import ChikuwaChat

/// A fake of the recurring-post calls: a list, and what the screens sent.
@MainActor
final class FakeRecurringApi: RecurringApi {
    var posts: [RecurringPostOut]
    var members: [String]
    var listError: Error?
    private(set) var creates: [(channelId: String, body: RecurringPostCreate)] = []
    private(set) var patches: [(id: String, patch: RecurringPostPatch)] = []
    private(set) var deletes: [String] = []
    private(set) var runs: [String] = []

    init(posts: [RecurringPostOut] = [], members: [String] = []) {
        self.posts = posts
        self.members = members
    }

    func recurringPosts(channelId: String) async throws -> [RecurringPostOut] {
        if let listError { throw listError }
        return posts.filter { $0.channelId == channelId }
    }

    func createRecurringPost(channelId: String, _ body: RecurringPostCreate) async throws -> RecurringPostOut {
        creates.append((channelId, body))
        let post = RecurringPostOut(id: "new\(creates.count)", channelId: channelId, botUserId: "bot", createdBy: "me", name: body.name, body: body.body,
                                    schedule: body.schedule, tz: body.tz, collect: body.collect, enabled: body.enabled, nextRunAt: "2026-10-08T00:00:00Z",
                                    lastRunAt: nil, createdAt: "", updatedAt: "")
        posts.append(post)
        return post
    }

    func updateRecurringPost(id: String, _ patch: RecurringPostPatch) async throws -> RecurringPostOut {
        patches.append((id, patch))
        guard let index = posts.firstIndex(where: { $0.id == id }) else { throw ApiError.api(status: 404, code: "recurring_post_not_found", message: "") }
        if let enabled = patch.enabled { posts[index].enabled = enabled }
        if let name = patch.name { posts[index].name = name }
        return posts[index]
    }

    func deleteRecurringPost(id: String) async throws {
        deletes.append(id)
        posts.removeAll { $0.id == id }
    }

    func runRecurringPost(id: String) async throws -> RecurringRunOut {
        runs.append(id)
        return RecurringRunOut(messageId: "m-\(id)")
    }

    func members(channelId: String) async throws -> [MemberOut] {
        members.map { MemberOut(userId: $0, role: "member", joinedAt: "") }
    }
}

/// L6 (M60), light and dark: the collection chip's states under a bot's post, 「提出状況」, the channel details' 「定期投稿」
/// (an owner's and a member's), and the full-screen form (new, and an edit that collects). Run with
/// TEST_RUNNER_SNAPSHOT_DIR=<dir> to look at them.
@MainActor
final class RecurringSnapshotTests: XCTestCase {
    override func setUp() { CalendarDates.zoneOverride = TimeZone(identifier: "Asia/Tokyo") }
    override func tearDown() { CalendarDates.zoneOverride = nil }

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

    private let channelId = "0199a0b0-1111-7000-8000-000000000001"
    private let people = [("me", "加納"), ("u-ebi", "海老原"), ("u-sato", "佐藤 美咲"), ("u-tanaka", "田中"), ("u-kim", "Kim"), ("u-mori", "森")]

    private func world(role: String = "owner", admin: Bool = false) -> AppController {
        let controller = AppController()
        let store = controller.store
        store.setMe(UserMe(id: "me", username: "kano", displayName: "加納", role: admin ? "admin" : "member", deactivatedAt: nil, createdAt: "",
                           updatedAt: "", email: nil, mustChangePassword: false))
        for (id, name) in people {
            store.upsertUser(UserPublic(id: id, username: id, displayName: name, role: "member", deactivatedAt: nil, createdAt: "", updatedAt: ""))
        }
        store.upsertUser(UserPublic(id: "bot", username: "bot-weekly", displayName: "週報", role: "bot", deactivatedAt: nil, createdAt: "", updatedAt: ""))
        store.upsertChannel(ChannelOut(id: channelId, type: "public", name: "週報", topic: nil, purpose: nil, archived: false, createdBy: nil, lastSeq: 0,
                                       lastMessageAt: nil, createdAt: "", updatedAt: "", membership: MembershipOut(role: role, joinedAt: ""), dmUserIds: nil),
                            isMember: true)
        store.groups = [
            "g-m2": GroupOut(id: "g-m2", name: "m2", memberIds: ["u-ebi", "u-sato"], createdBy: "me", createdAt: "", updatedAt: ""),
            "g-b4": GroupOut(id: "g-b4", name: "b4", memberIds: ["u-tanaka", "u-kim", "u-mori"], createdBy: "me", createdAt: "", updatedAt: ""),
        ]
        return controller
    }

    private func iso(_ date: Date) -> String { ISO8601DateFormatter().string(from: date) }

    private func bot(_ id: String, body: String, seq: Int, collection: CollectionOut?) -> MessageState {
        var message = MessageState(MessageOut(id: id, channelId: channelId, senderId: "bot", seq: seq, updatedSeq: seq, clientMsgId: nil, body: body,
                                              createdAt: "2026-10-01T00:00:00Z", editedAt: nil, deleted: false, collection: collection))
        message.replyCount = collection?.submittedUserIds.count ?? 0
        return message
    }

    private var targets: [String] { people.map(\.0) }

    func testChips() throws {
        let soon = iso(Date().addingTimeInterval(3 * 86_400))
        let past = iso(Date().addingTimeInterval(-3600))
        let rows = [
            bot("c1", body: "**週報 2026/10/01 (木)**\nこのスレッドに今週の進捗を返信してください", seq: 1,
                collection: CollectionOut(dueAt: soon, targetUserIds: targets, submittedUserIds: ["u-ebi", "u-sato"])),  // mine: pending
            bot("c2", body: "**週報 2026/09/24 (木)**", seq: 2,
                collection: CollectionOut(dueAt: past, targetUserIds: targets, submittedUserIds: ["u-ebi"])),  // pending, overdue
            bot("c3", body: "**週報 2026/09/17 (木)**", seq: 3,
                collection: CollectionOut(dueAt: soon, targetUserIds: targets, submittedUserIds: ["me", "u-kim"])),  // submitted
            bot("c4", body: "**B4 日報 {date}**", seq: 4,
                collection: CollectionOut(dueAt: past, targetUserIds: ["u-tanaka", "u-kim"], submittedUserIds: ["u-tanaka", "u-kim"])),  // not mine, complete
        ]
        for style in [UIUserInterfaceStyle.light, .dark] {
            let controller = world()
            let view = ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    ForEach(rows) { message in
                        MessageRow(message: message, controller: controller, margin: 12, present: { _ in })
                    }
                }
                .padding(.vertical, 12)
            }
            _ = try render(view, style: style, name: "recurring-chips-\(style == .dark ? "dark" : "light").png")
        }
    }

    func testStatusSheet() throws {
        let message = bot("c1", body: "週報", seq: 1,
                          collection: CollectionOut(dueAt: "2026-10-09T09:00:00Z", targetUserIds: targets, submittedUserIds: ["u-ebi", "u-sato", "u-kim"]))
        for style in [UIUserInterfaceStyle.light, .dark] {
            let controller = world()
            _ = try render(CollectionStatusView(message: message, controller: controller, now: parseIsoDate("2026-10-08T00:00:00Z")), style: style,
                           name: "recurring-status-\(style == .dark ? "dark" : "light").png")
        }
        let done = bot("c4", body: "日報", seq: 4,
                       collection: CollectionOut(dueAt: "2026-10-09T09:00:00Z", targetUserIds: ["u-tanaka", "u-kim"], submittedUserIds: ["u-tanaka", "u-kim"],
                                                 remindedAt: "2026-10-09T09:00:10Z"))
        _ = try render(CollectionStatusView(message: done, controller: world(), now: parseIsoDate("2026-10-10T00:00:00Z")), style: .light,
                       name: "recurring-status-done-light.png")
    }

    private func posts() -> [RecurringPostOut] {
        [
            RecurringPostOut(id: "p1", channelId: channelId, botUserId: "bot", createdBy: "me", name: "週報", body: "**週報 {date}**",
                             schedule: .weekly([3], time: "09:00"), tz: "Asia/Tokyo",
                             collect: CollectSpec(targets: CollectTargets(allMembers: true), due: CollectDue(afterDays: 3, time: "18:00")), enabled: true,
                             nextRunAt: "2026-10-08T00:00:00Z", lastRunAt: "2026-10-01T00:00:00Z", createdAt: "", updatedAt: ""),
            RecurringPostOut(id: "p2", channelId: channelId, botUserId: "bot2", createdBy: "me", name: "B4 日報", body: "{date} の日報",
                             schedule: .weekly([0, 1, 2, 3, 4], time: "17:30"), tz: "Asia/Tokyo",
                             collect: CollectSpec(targets: CollectTargets(groupIds: ["g-b4"], userIds: ["u-ebi"]), due: CollectDue(afterDays: 0, time: "23:00")),
                             enabled: false, nextRunAt: "2026-10-01T08:30:00Z", lastRunAt: nil, createdAt: "", updatedAt: ""),
            RecurringPostOut(id: "p3", channelId: channelId, botUserId: "bot3", createdBy: "me", name: "月例会の議題", body: "来週の月例会の議題をどうぞ",
                             schedule: .monthly(31, time: "10:00"), tz: "America/New_York", collect: nil, enabled: true,
                             nextRunAt: "2026-10-31T14:00:00Z", lastRunAt: nil, createdAt: "", updatedAt: ""),
        ]
    }

    func testList() throws {
        for style in [UIUserInterfaceStyle.light, .dark] {
            let suffix = style == .dark ? "dark" : "light"
            for (role, name) in [("owner", "owner"), ("member", "member")] {
                let controller = world(role: role)
                let channel = try XCTUnwrap(controller.store.channel(channelId))
                let api = FakeRecurringApi(posts: posts())
                let view = NavigationStack {
                    Form { RecurringPostsSection(controller: controller, channel: channel, api: api) }
                        .navigationTitle("#週報").navigationBarTitleDisplayMode(.inline)
                }
                _ = try render(view, style: style, name: "recurring-list-\(name)-\(suffix).png")
            }
        }
        // Nothing yet, for an owner.
        let controller = world()
        let view = NavigationStack {
            Form { RecurringPostsSection(controller: controller, channel: controller.store.channel(channelId)!, api: FakeRecurringApi()) }
        }
        _ = try render(view, style: .light, name: "recurring-list-empty-light.png")
    }

    func testForm() throws {
        for style in [UIUserInterfaceStyle.light, .dark] {
            let suffix = style == .dark ? "dark" : "light"
            let controller = world()
            let channel = try XCTUnwrap(controller.store.channel(channelId))
            let api = FakeRecurringApi(posts: posts(), members: targets + ["bot"])
            _ = try render(RecurringPostForm(controller: controller, channel: channel, target: .new, api: api, memberIds: targets), style: style,
                           name: "recurring-form-new-\(suffix).png")
            _ = try render(RecurringPostForm(controller: controller, channel: channel, target: .post(posts()[1]), api: api, memberIds: targets),
                           size: CGSize(width: 393, height: 1400), style: style, name: "recurring-form-edit-\(suffix).png")
            _ = try render(RecurringPostForm(controller: controller, channel: channel, target: .post(posts()[2]), api: api, memberIds: targets),
                           style: style, name: "recurring-form-monthly-\(suffix).png")
        }
    }

    func testRemindersShowACollectNudge() throws {
        let controller = world()
        controller.store.applyReminder(ReminderOut(id: "r1", messageId: "m1", channelId: channelId, note: "週報 の提出をお願いします (締切 10/9 (金) 18:00)",
                                                   preview: "週報 2026/10/01 (木)", remindAt: "2026-10-09T09:00:00Z", status: "fired",
                                                   firedAt: "2026-10-09T09:00:05Z", createdAt: "", kind: "collect"))
        controller.store.applyReminder(ReminderOut(id: "r2", messageId: "m2", channelId: channelId, note: "加納 さんから確認のお願い",
                                                   preview: "来週のゼミは休みです", remindAt: "2026-10-09T08:00:00Z", status: "fired",
                                                   firedAt: "2026-10-09T08:00:05Z", createdAt: "", kind: "ack"))
        for style in [UIUserInterfaceStyle.light, .dark] {
            _ = try render(NavigationStack { RemindersView(controller: controller) { _ in } }, style: style,
                           name: "recurring-reminders-\(style == .dark ? "dark" : "light").png")
        }
    }
}
