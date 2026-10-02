import SwiftUI
import XCTest
@testable import ChikuwaChat

/// M66, light and dark: the summary sheet while the run is being written, done (Markdown, the omitted rows' note) and
/// refused; the channel details' AI section. Run with TEST_RUNNER_SNAPSHOT_DIR=<dir> to look at them.
@MainActor
final class AiSummarySnapshotTests: XCTestCase {
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

    private func world() -> AppController {
        let controller = AppController()
        let store = controller.store
        store.setMe(UserMe(id: "me", username: "kano", displayName: "加納", role: "member", deactivatedAt: nil, createdAt: "",
                           updatedAt: "", email: nil, mustChangePassword: false))
        store.upsertChannel(ChannelOut(id: channelId, type: "public", name: "研究室", topic: nil, purpose: nil, archived: false, createdBy: nil, lastSeq: 0,
                                       lastMessageAt: nil, createdAt: "", updatedAt: "", membership: MembershipOut(role: "member", joinedAt: ""), dmUserIds: nil),
                            isMember: true)
        return controller
    }

    private let output = """
    ## 直近 7 日のまとめ
    - **ゼミの日程**: 10/9 (木) 13:00 に決定
    - 実験装置の予約は *海老原* さんが担当
    - 未解決: 学会の締め切りの確認

    > 次回までに各自スライドを共有
    """

    private func hub(_ run: AiRunOut?, failure: Error? = nil, request: AiSummaryRequest) async -> AiHub {
        let api = FakeAiApi()
        if let failure { api.createResult = .failure(failure) } else if let run { api.createResult = .success(run) }
        let hub = AiHub(api: api)
        await hub.startSummary(request)
        return hub
    }

    func testSheet() async throws {
        let request = AiSummaryRequest(channelId: channelId, scope: .recent(days: 7))
        let done = AiRunOut(id: "r1", status: "done", channelId: channelId, scope: "recent", days: 7, output: output, omittedCount: 42,
                            provider: "openai", model: "gpt-6.1-sol")
        for style in [UIUserInterfaceStyle.light, .dark] {
            let suffix = style == .dark ? "dark" : "light"
            let doneHub = await hub(done, request: request)
            XCTAssertEqual(doneHub.summary?.phase, .done(output: output, omittedCount: 42))
            _ = try render(AiSummarySheet(controller: world(), hub: doneHub, request: request), style: style, name: "ai-summary-done-\(suffix).png")
            let working = await hub(AiRunOut(id: "r1", status: "running", channelId: channelId), request: request)
            _ = try render(AiSummarySheet(controller: world(), hub: working, request: request), style: style, name: "ai-summary-working-\(suffix).png")
        }
        let thread = AiSummaryRequest(channelId: channelId, scope: .thread(parentId: "p1"))
        let refused = await hub(nil, failure: ApiError.api(status: 429, code: "ai_budget_exceeded", message: ""), request: thread)
        _ = try render(AiSummarySheet(controller: world(), hub: refused, request: thread), style: .light, name: "ai-summary-failed-light.png")
    }

    /// M71: the 「AI に聞く」 sheet — the answer with [n] links, the omitted note, the sources and the caption; working;
    /// refused; the past questions. And the row above the search results.
    func testAskSheet() async throws {
        let m1 = "0199a0b0-0000-7000-8000-000000000001"
        let m2 = "0199a0b0-0000-7000-8000-000000000002"
        let answer = """
        ゼミは **10/9 (木) 13:00** に決まりました [1]。場所は 3 階のセミナー室です [1][2]。
        - 発表は加納さんと海老原さん [2]
        """
        let sources = [
            AiSourceOut(n: 1, messageId: m1, channelId: channelId, senderId: "u1", createdAt: "2026-09-30T04:12:00Z",
                        excerpt: "来週のゼミは 10/9 (木) 13:00 から、3 階のセミナー室で行います"),
            AiSourceOut(n: 2, messageId: m2, channelId: channelId, parentId: m1, senderId: "u2", createdAt: "2026-09-30T05:40:00Z",
                        excerpt: "発表は加納さんと海老原さんでお願いします。資料は前日までに共有してください"),
        ]
        func controller() -> AppController {
            let controller = world()
            controller.api = ApiClient(baseUrl: URL(string: "https://chat.example.jp")!)
            controller.store.upsertUser(UserPublic(id: "u1", username: "tanaka", displayName: "田中", role: "member", deactivatedAt: nil, createdAt: "", updatedAt: ""))
            controller.store.upsertUser(UserPublic(id: "u2", username: "ebi", displayName: "海老原", role: "member", deactivatedAt: nil, createdAt: "", updatedAt: ""))
            return controller
        }
        func hub(_ result: Result<AiRunOut, Error>) async -> AiHub {
            let api = FakeAiApi()
            api.askResult = result
            api.history = .success([AiRunOut(id: "q1", kind: "ask", status: "done", channelId: "", createdAt: "2026-10-02T01:00:00Z", question: "ゼミの日程は?"),
                                    AiRunOut(id: "q0", kind: "ask", status: "failed", channelId: "", createdAt: "2026-10-01T09:30:00Z", question: "学会の締め切りはいつ?")])
            let hub = AiHub(api: api)
            await hub.startAsk(AiAskRequest(question: "ゼミの日程は? from:@tanaka", channelId: channelId))
            return hub
        }
        let done = AiRunOut(id: "q1", kind: "ask", status: "done", channelId: channelId, output: answer, omittedCount: 3, provider: "anthropic",
                            model: "claude-opus-5-5", question: "ゼミの日程は? from:@tanaka", sources: sources)
        let target = AiAskTargetOut(available: true, provider: "anthropic", model: "claude-opus-5-5", agentName: "ちくわ")
        for style in [UIUserInterfaceStyle.light, .dark] {
            let suffix = style == .dark ? "dark" : "light"
            let doneHub = await hub(.success(done))
            guard case .done(let output, 3, let shown) = doneHub.ask?.phase else { return XCTFail("not done") }
            XCTAssertEqual(output, answer)
            XCTAssertEqual(shown, sources)
            _ = try render(AiAskSheet(controller: controller(), hub: doneHub) { _ in }, style: style, name: "ai-ask-done-\(suffix).png")
            let working = await hub(.success(AiRunOut(id: "q1", kind: "ask", status: "running", channelId: "")))
            _ = try render(AiAskSheet(controller: controller(), hub: working) { _ in }, style: style, name: "ai-ask-working-\(suffix).png")
            let bar = VStack(spacing: 0) {
                AiAskBar(hub: doneHub, target: target, canAsk: true, onAsk: {}, onSheet: { _ in }).padding()
                AiAskBar(hub: AiHub(api: nil), target: AiAskTargetOut(available: false, provider: "anthropic", reason: "ai_private_not_allowed"),
                         canAsk: false, onAsk: {}, onSheet: { _ in }).padding()
                Spacer()
            }
            _ = try render(bar, style: style, name: "ai-ask-bar-\(suffix).png")
        }
        let refused = await hub(.failure(ApiError.api(status: 429, code: "ai_daily_limit", message: "")))
        XCTAssertEqual(refused.ask?.phase, .failed(ErrorMessages.byCode["ai_daily_limit"]!))
        _ = try render(AiAskSheet(controller: controller(), hub: refused) { _ in }, style: .light, name: "ai-ask-failed-light.png")
        let historyHub = await hub(.success(done))
        _ = try render(AiAskSheet(controller: controller(), hub: historyHub, startInHistory: true) { _ in }, style: .light, name: "ai-ask-history-light.png")
    }

    func testChannelSection() throws {
        let notice = AiRules.notice([AiAgentPublic(id: "a1", botUserId: "u-bot", name: "ちくわ")])
        for style in [UIUserInterfaceStyle.light, .dark] {
            let view = NavigationStack {
                Form { AiChannelSection(channelId: channelId, notice: notice, canSummarize: true) { _ in } }
                    .navigationTitle("#研究室").navigationBarTitleDisplayMode(.inline)
            }
            _ = try render(view, style: style, name: "ai-channel-section-\(style == .dark ? "dark" : "light").png")
        }
    }
}
