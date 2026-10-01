import SwiftUI
import XCTest
@testable import ChikuwaChat

/// M54 (SCHEDULING.md §5), light and dark: the form (日程調整を作成), the card open and decided, and the people ×
/// candidates table. Run with TEST_RUNNER_SNAPSHOT_DIR=<dir> to look at them.
@MainActor
final class ScheduleSnapshotTests: XCTestCase {
    private typealias S = SchedulePoll

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

    private func controller(me: String = "u-alice") -> AppController {
        let controller = AppController()
        let store = controller.store
        store.setMe(UserMe(id: me, username: "alice", displayName: "Alice", role: "member", deactivatedAt: nil, createdAt: "", updatedAt: "",
                           email: nil, mustChangePassword: false))
        for (id, name) in [("u-alice", "加納"), ("u-bob", "海老原"), ("u-carol", "竹輪"), ("u-dan", "山田 太郎")] {
            store.upsertUser(UserPublic(id: id, username: id, displayName: name, role: "member", deactivatedAt: nil, createdAt: "", updatedAt: ""))
        }
        store.upsertChannel(ChannelOut(id: "c1", type: "public", name: "lab", topic: nil, purpose: nil, archived: false, createdBy: nil, lastSeq: 0,
                                       lastMessageAt: nil, createdAt: "", updatedAt: "", membership: MembershipOut(role: "member", joinedAt: ""),
                                       dmUserIds: nil), isMember: true)
        return controller
    }

    private let options = ["10/3 (土) 14:00〜15:00", "10/3 (土) 15:30〜16:30", "10/5 (月) 終日", "10/6 (火) 22:00〜24:00"]

    /// [yes, maybe, no] per candidate.
    private func poll(_ answers: [([String], [String], [String])], anonymous: Bool = false, decided: PollDecidedOut? = nil,
                      comments: [PollCommentOut] = [], myAnswers: [String?]? = nil, myComment: String? = nil) -> PollOut {
        var poll = PollOut(question: "M2 中間発表の練習", options: options, multiple: true, closedAt: decided == nil ? nil : "2026-10-01T05:00:00Z",
                           votes: answers.map { anonymous ? [] : $0.0 }, anonymous: anonymous, counts: answers.map { $0.0.count })
        poll.kind = "schedule"
        poll.tz = "Asia/Tokyo"
        poll.decided = decided
        poll.answers = answers.map { yes, maybe, no in
            SlotAnswersOut(yes: anonymous ? [] : yes, maybe: anonymous ? [] : maybe, no: anonymous ? [] : no,
                           yesCount: yes.count, maybeCount: maybe.count, noCount: no.count)
        }
        var seen: [String] = []
        for (yes, maybe, no) in answers { for id in yes + maybe + no where !seen.contains(id) { seen.append(id) } }
        poll.respondents = anonymous ? [] : seen
        poll.comments = comments
        poll.myAnswers = myAnswers
        poll.myComment = myComment
        return poll
    }

    private var named: PollOut {
        poll([(["u-bob", "u-carol", "u-alice"], ["u-dan"], []),
              (["u-bob"], ["u-alice"], ["u-carol", "u-dan"]),
              (["u-carol", "u-dan"], [], ["u-bob"]),
              ([], [], ["u-alice", "u-bob", "u-carol"])],
             comments: [PollCommentOut(userId: "u-bob", text: "15 時までなら大丈夫です"), PollCommentOut(userId: "u-alice", text: "午後なら")])
    }

    private func message(_ poll: PollOut, sender: String = "u-alice") -> MessageState {
        var state = MessageState(try! JSON.snakeDecoder.decode(MessageOut.self, from: Data("""
        {"id": "m1", "channel_id": "c1", "sender_id": "\(sender)", "seq": 3, "updated_seq": 3, "client_msg_id": null,
         "body": "📊 M2 中間発表の練習", "created_at": "2026-10-01T04:00:00Z", "edited_at": null, "deleted": false}
        """.utf8)))
        state.poll = poll
        return state
    }

    private func card(_ poll: PollOut, controller: AppController, sender: String = "u-alice") -> some View {
        ScrollView {
            PollCardView(poll: poll, message: message(poll, sender: sender), controller: controller)
                .padding(.horizontal, 16)
                .padding(.leading, 44) // a message row's avatar column
        }
    }

    func testForm() throws {
        for style in [UIUserInterfaceStyle.light, .dark] {
            let suffix = style == .dark ? "dark" : "light"
            let initial = ScheduleFormInitial(question: "M2 中間発表の練習", slots: [.timed("2026-10-03", 14 * 60), .timed("2026-10-03", 15 * 60 + 30),
                                                                               .timed("2026-10-06", 22 * 60, minutes: 120), .timed("2026-10-07", 14 * 60)])
            let view = ScheduleFormView(controller: controller(), channelId: "c1", parentId: nil, initial: initial,
                                        now: parseIsoDate("2026-10-01T01:00:00Z")!)
            _ = try render(view, size: CGSize(width: 393, height: 1500), style: style, name: "schedule-form-\(suffix).png")
            let empty = ScheduleFormView(controller: controller(), channelId: "c1", parentId: nil, now: parseIsoDate("2026-10-01T01:00:00Z")!)
            _ = try render(empty, style: style, name: "schedule-form-empty-\(suffix).png")
        }
    }

    func testCardOpenAndDecided() throws {
        for style in [UIUserInterfaceStyle.light, .dark] {
            let suffix = style == .dark ? "dark" : "light"
            // The author: 決める on every candidate; my answers ○ △ - ×; the most ○ starred (a tie stars both).
            _ = try render(card(named, controller: controller()), size: CGSize(width: 393, height: 760), style: style,
                           name: "schedule-card-open-\(suffix).png")
            // A member, anonymous: no names, mine from my_answers, no 決める.
            let hidden = poll([(["a", "b"], ["c"], []), (["a"], [], ["b"]), (["a", "b"], [], []), ([], [], ["a"])], anonymous: true,
                              comments: [PollCommentOut(userId: nil, text: "どちらでも")], myAnswers: ["yes", nil, "yes", "no"], myComment: "どちらでも")
            _ = try render(card(hidden, controller: controller(me: "u-bob")), size: CGSize(width: 393, height: 700), style: style,
                           name: "schedule-card-anonymous-\(suffix).png")
            var decided = named
            decided.decided = PollDecidedOut(index: 0, eventId: "e1", by: "u-alice", at: "2026-10-01T05:00:00Z")
            decided.closedAt = "2026-10-01T05:00:00Z"
            _ = try render(card(decided, controller: controller()), size: CGSize(width: 393, height: 820), style: style,
                           name: "schedule-card-decided-\(suffix).png")
        }
    }

    func testTable() throws {
        for style in [UIUserInterfaceStyle.light, .dark] {
            let suffix = style == .dark ? "dark" : "light"
            let image = try render(ScheduleTableView(poll: named, message: message(named), controller: controller()), style: style,
                                   name: "schedule-table-\(suffix).png")
            XCTAssertGreaterThan(image.size.width, 0)
        }
    }
}
