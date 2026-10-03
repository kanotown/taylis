import SwiftUI
import XCTest
@testable import ChikuwaChat

/// M95, light and dark: a message with its 「⚡ name」 label, the list a channel offers (one greyed with its reason) and
/// the full-screen form with every kind of field and its preview. Run with SNAPSHOT_DIR=<dir> to look at them.
@MainActor
final class WorkflowSnapshotTests: XCTestCase {
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

    private let here = "0199a0b0-1111-7000-8000-000000000001"
    private let report = "0199a0b0-1111-7000-8000-000000000002"
    private let me = "0190a1b2-0000-7000-8000-000000000001"

    private func world() -> AppController {
        let controller = AppController()
        let store = controller.store
        store.setMe(UserMe(id: me, username: "kano", displayName: "加納", role: "member", deactivatedAt: nil, createdAt: "", updatedAt: "",
                           email: nil, mustChangePassword: false))
        store.upsertUser(UserPublic(id: me, username: "kano", displayName: "加納", role: "member", deactivatedAt: nil, createdAt: "", updatedAt: ""))
        for (id, name) in [(here, "2026ゼミ"), (report, "報告-ゼミ欠席")] {
            store.upsertChannel(ChannelOut(id: id, type: "public", name: name, topic: nil, purpose: nil, archived: false, createdBy: nil, lastSeq: 0,
                                           lastMessageAt: nil, createdAt: "", updatedAt: "", membership: MembershipOut(role: "member", joinedAt: ""),
                                           dmUserIds: nil), isMember: true)
        }
        return controller
    }

    private var absence: WorkflowOut {
        WorkflowOut(id: "w1", name: "ゼミ欠席報告", description: "ゼミを欠席・遅刻・早退するときに", channelId: report, fields: [
            WorkflowField(key: "報告者", label: "報告者", type: "user", required: true, defaultValue: WorkflowFieldDefault(kind: "me")),
            WorkflowField(key: "日付", label: "日付", type: "date", required: true, defaultValue: WorkflowFieldDefault(kind: "today")),
            WorkflowField(key: "内容", label: "報告の内容", type: "select", required: true, options: ["欠席", "遅刻", "早退"],
                          defaultValue: WorkflowFieldDefault(kind: "literal", value: .string("欠席"))),
            WorkflowField(key: "時刻", label: "到着予定", type: "time", help: "遅刻のときだけ"),
            WorkflowField(key: "次回", label: "次回", type: "datetime", defaultValue: WorkflowFieldDefault(kind: "next_weekday", weekday: 1, time: "13:00")),
            WorkflowField(key: "理由", label: "理由", type: "textarea"),
            WorkflowField(key: "連絡", label: "指導教員に連絡済み", type: "checkbox", required: true),
        ], template: "*【報告者】* {{報告者}}\n*【報告の内容】* ゼミの{{内容}}\n*【日付】* {{日付}}\n*【到着】* {{時刻}}\n*【理由】* {{理由}}")
    }

    func testLabelListAndForm() throws {
        for style in [UIUserInterfaceStyle.light, .dark] {
            let suffix = style == .dark ? "dark" : "light"
            let controller = world()
            let posted = MessageState(MessageOut(id: "m1", channelId: report, senderId: me, seq: 1, updatedSeq: 1, clientMsgId: nil,
                                                 body: "*【報告者】* <@\(me)>\n*【報告の内容】* ゼミの欠席", createdAt: "2026-10-04T00:00:00Z",
                                                 editedAt: nil, deleted: false, workflow: MessageWorkflow(id: "w1", name: "ゼミ欠席報告")))
            let plain = MessageState(MessageOut(id: "m2", channelId: report, senderId: me, seq: 2, updatedSeq: 2, clientMsgId: nil,
                                                body: "ふつうの投稿", createdAt: "2026-10-04T00:01:00Z", editedAt: nil, deleted: false))
            let rows = ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    MessageRow(message: posted, controller: controller, margin: 12, present: { _ in })
                    MessageRow(message: plain, controller: controller, margin: 12, present: { _ in })
                }
            }
            _ = try render(rows, style: style, name: "workflow-label-\(suffix).png")

            controller.workflowLists[here] = (Date(), [
                absence,
                WorkflowOut(id: "w2", name: "学部ゼミ案内", emoji: "📣", channelId: here, template: "x", canRun: false, runBlocked: "posting_restricted"),
                WorkflowOut(id: "w3", name: "書誌情報報告", emoji: "📚", channelId: here, template: "x", enabled: false, canRun: false, runBlocked: "disabled"),
            ])
            let list = NavigationStack { WorkflowListView(controller: controller, channelId: here) { _ in } }
            _ = try render(list, style: style, name: "workflow-list-\(suffix).png")

            let form = WorkflowFormView(controller: controller, target: WorkflowRunTarget(workflow: absence, here: here))
            _ = try render(form, size: CGSize(width: 393, height: 1500), style: style, name: "workflow-form-\(suffix).png")
        }
    }

    /// The label is one line: a message with it is as tall as without it plus that line, whatever the name's length.
    func testLabelHeightIsFixed() {
        let short = UIHostingController(rootView: WorkflowLabel(name: "報告") {}).sizeThatFits(in: CGSize(width: 300, height: 1000))
        let long = UIHostingController(rootView: WorkflowLabel(name: String(repeating: "とても長いワークフローの名前", count: 4)) {})
            .sizeThatFits(in: CGSize(width: 300, height: 1000))
        XCTAssertEqual(short.height, long.height, accuracy: 0.5)
        XCTAssertLessThanOrEqual(long.width, 300.5)
    }
}
