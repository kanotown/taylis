import SwiftUI
import XCTest
@testable import ChikuwaChat

/// M52 (CALENDAR.md §7), light and dark: the calendar's list and month, the event form (new, mine, someone else's) and a
/// channel's 「予定」 tab. Run with TEST_RUNNER_SNAPSHOT_DIR=<dir> to look at them.
@MainActor
final class CalendarSnapshotTests: XCTestCase {
    private typealias F = CalendarFixtures
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
    private let m2Id = "0199f000-aaaa-7bbb-8ccc-0123456789ab"

    private func world() -> (AppController, FakeCalendarApi) {
        let controller = AppController()
        let store = controller.store
        store.setMe(UserMe(id: "me", username: "kano", displayName: "Kano", role: "member", deactivatedAt: nil, createdAt: "", updatedAt: "",
                           email: nil, mustChangePassword: false))
        for (id, name, type) in [(labId, "lab", "public"), (m2Id, "m2-進捗", "private")] {
            store.upsertChannel(ChannelOut(id: id, type: type, name: name, topic: nil, purpose: nil, archived: false, createdBy: nil, lastSeq: 0,
                                           lastMessageAt: nil, createdAt: "", updatedAt: "", membership: MembershipOut(role: "member", joinedAt: ""),
                                           dmUserIds: nil), isMember: true)
        }
        let api = FakeCalendarApi([
            F.timed("ゼミ", "2026-10-01T05:00:00Z", "2026-10-01T06:30:00Z", channelId: labId, channelName: "lab", ownerId: "bob", canEdit: false,
                    alarm: F.alarm(10), location: "5 号館 501"),
            F.allDay("学園祭 (休講)", "2026-10-01", "2026-10-03", channelId: m2Id, channelName: "m2-進捗"),
            F.timed("歯医者", "2026-10-02T00:30:00Z", "2026-10-02T01:30:00Z"),
            F.timed("進捗報告", "2026-10-06T04:00:00Z", "2026-10-06T05:00:00Z", channelId: m2Id, channelName: "m2-進捗"),
            F.timed("夜間実験", "2026-10-08T12:00:00Z", "2026-10-08T17:00:00Z", channelId: labId, channelName: "lab", location: "実験棟 B1"),
            F.allDay("学会 (京都)", "2026-10-14", "2026-10-16"),
            F.timed("輪講", "2026-10-20T06:00:00Z", "2026-10-20T07:00:00Z", channelId: labId, channelName: "lab"),
        ])
        return (controller, api)
    }

    private func hub(_ api: FakeCalendarApi) -> CalendarHub { CalendarHub(api: api, me: { "me" }) }

    func testListAndMonth() throws {
        for style in [UIUserInterfaceStyle.light, .dark] {
            let suffix = style == .dark ? "dark" : "light"
            let (controller, api) = world()
            UserDefaults.standard.set(CalendarView.Mode.list.rawValue, forKey: CalendarView.modeKey)
            let list = try render(NavigationStack { CalendarView(controller: controller, hub: hub(api), today: today) }, style: style,
                                  name: "calendar-list-\(suffix).png")
            XCTAssertGreaterThan(list.size.width, 0)
            UserDefaults.standard.set(CalendarView.Mode.month.rawValue, forKey: CalendarView.modeKey)
            _ = try render(NavigationStack { CalendarView(controller: controller, hub: hub(api), today: today) }, style: style,
                           name: "calendar-month-\(suffix).png")
        }
        XCTAssertTrue(true)
    }

    func testForms() throws {
        for style in [UIUserInterfaceStyle.light, .dark] {
            let suffix = style == .dark ? "dark" : "light"
            let (controller, api) = world()
            let hub = hub(api)
            var draft = EventDraft.new(on: today, channelId: labId, now: parseIsoDate("2026-09-01T00:00:00Z")!)
            draft.title = "M2 中間発表の練習"
            draft.alarm = 15
            _ = try render(CalendarEventForm(controller: controller, hub: hub, target: .new(draft)), style: style, name: "calendar-form-new-\(suffix).png")
            var mine = api.rows[1]
            mine.canEdit = true
            mine.description = "10/1〜10/3 は講義なし。研究室は開いています。"
            _ = try render(CalendarEventForm(controller: controller, hub: hub, target: .event(mine)), style: style, name: "calendar-form-edit-\(suffix).png")
            _ = try render(CalendarEventForm(controller: controller, hub: hub, target: .event(api.rows[0])), style: style,
                           name: "calendar-form-readonly-\(suffix).png")
        }
    }

    func testChannelTab() throws {
        for style in [UIUserInterfaceStyle.light, .dark] {
            let suffix = style == .dark ? "dark" : "light"
            let (controller, api) = world()
            let channel = try XCTUnwrap(controller.store.channel(labId))
            let hub = hub(api)
            let view = NavigationStack {
                VStack(spacing: 0) {
                    ChannelTabsRow(controller: controller, channel: channel, tab: .constant(.events), upcoming: 1, onAddLink: {}, onEditLink: { _ in })
                    ChannelEventsPane(controller: controller, channel: channel, hub: hub, today: today)
                }
                .navigationTitle("#lab")
                .navigationBarTitleDisplayMode(.inline)
            }
            _ = try render(view, style: style, name: "calendar-channel-tab-\(suffix).png")
            XCTAssertEqual(api.eventsCalls.last?.channelId, labId)
        }
    }
}
