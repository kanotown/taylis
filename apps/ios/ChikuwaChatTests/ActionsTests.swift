import XCTest
@testable import ChikuwaChat

/// M143 (docs/ACTIONS.md §9.2): 操作ボタン on the phone — decoding, grouping and texts, who sees the tile and where the
/// buttons show, one press per id (a network retry keeps it, the relay is called once), the refusals, and the engine
/// (bootstrap, actions.updated).
@MainActor
final class ActionsTests: XCTestCase {
    private func action(_ id: String, _ name: String, group: String? = nil, icon: String? = nil, emoji: String? = nil, confirm: Bool = true,
                        confirmText: String? = nil, position: Int = 0) -> ActionOut {
        ActionOut(id: id, name: name, groupLabel: group, icon: icon, emoji: emoji, confirm: confirm, confirmText: confirmText, position: position)
    }

    private var unlock: ActionOut { action("a-unlock", "開ける", group: "研究室の鍵", emoji: "🔓", position: 0) }
    private var lock: ActionOut { action("a-lock", "閉める", group: "研究室の鍵", emoji: "🔒", position: 1) }
    private var light: ActionOut { action("a-light", "照明", icon: "lab", confirm: false, position: 2) }
    private var room: ActionOut { action("a-room", "教授室を開ける", group: "教授室", position: 3) }

    private func list(enabled: Bool = true, onAttendance: Bool = false, _ actions: [ActionOut]? = nil) -> ActionListOut {
        ActionListOut(enabled: enabled, showOnAttendance: onAttendance, actions: actions ?? [unlock, lock, light, room])
    }

    private func out(ok: Bool = true, status: String = "succeeded", code: Int? = 200, error: String? = nil, message: String? = nil) -> ActionInvokeOut {
        ActionInvokeOut(invokeId: "i1", actionId: "a-unlock", ok: ok, status: status, statusCode: code, error: error, message: message,
                        at: "2026-10-07T00:00:00Z")
    }

    // MARK: decoding

    func testDecodesTheListTheAnswerAndTheBootstrapField() throws {
        let json = """
        {"enabled": true, "show_on_attendance": true,
         "actions": [{"id": "a1", "name": "開ける", "group_label": "研究室の鍵", "icon": null, "emoji": "🔓", "confirm": true,
                      "confirm_text": "本当に開けますか？", "position": 0},
                     {"id": "a2", "name": "照明", "group_label": null, "icon": "lab", "emoji": null, "confirm": false,
                      "confirm_text": null, "position": 1}]}
        """
        let decoded = try JSON.snakeDecoder.decode(ActionListOut.self, from: Data(json.utf8))
        XCTAssertTrue(decoded.enabled)
        XCTAssertTrue(decoded.showOnAttendance)
        XCTAssertEqual(decoded.actions.map(\.id), ["a1", "a2"])
        XCTAssertEqual(decoded.actions[0].groupLabel, "研究室の鍵")
        XCTAssertEqual(decoded.actions[0].confirmText, "本当に開けますか？")
        XCTAssertEqual(decoded.actions[1].icon, "lab")
        XCTAssertFalse(decoded.actions[1].confirm)

        let answer = """
        {"invoke_id": "0192f0c2-0000-7000-8000-000000000001", "action_id": "a1", "ok": false, "status": "failed",
         "status_code": null, "error": "timeout", "message": null, "at": "2026-10-07T09:15:00.123456Z", "repeated": true}
        """
        let invoked = try JSON.snakeDecoder.decode(ActionInvokeOut.self, from: Data(answer.utf8))
        XCTAssertFalse(invoked.ok)
        XCTAssertEqual(invoked.error, "timeout")
        XCTAssertNil(invoked.statusCode)
        XCTAssertTrue(invoked.repeated)

        // The bootstrap's field: null for guests and while off, missing from an older server.
        let bootstrapJson = """
        {"server_time": "2026-10-07T00:00:00Z", "me": {"id": "me", "username": "me", "display_name": "Me", "role": "member",
          "deactivated_at": null, "created_at": "", "updated_at": "", "email": null, "must_change_password": false},
         "users": [], "channels": [], "limits": {"max_message_length": 1, "max_attachment_bytes": 1, "max_attachments_per_message": 1},
         "actions": \(json)}
        """
        let bootstrap = try JSON.snakeDecoder.decode(BootstrapOut.self, from: Data(bootstrapJson.utf8))
        XCTAssertEqual(bootstrap.actions, decoded)
        let older = bootstrapJson.replacingOccurrences(of: ",\n \"actions\": \(json)", with: "")
        XCTAssertNil(try JSON.snakeDecoder.decode(BootstrapOut.self, from: Data(older.utf8)).actions)
    }

    // MARK: the rules

    func testGroupsInOrderWithTheUngroupedLast() {
        let groups = ActionRules.groups([room, light, lock, unlock])
        XCTAssertEqual(groups.map(\.label), ["研究室の鍵", "教授室", nil])
        XCTAssertEqual(groups.map { $0.actions.map(\.name) }, [["開ける", "閉める"], ["教授室を開ける"], ["照明"]])
        // A blank group is no group.
        XCTAssertEqual(ActionRules.groups([action("x", "X", group: "  ")]).map(\.label), [nil])
    }

    func testTitlesAndTheConfirmation() {
        XCTAssertEqual(ActionRules.title(unlock), "研究室の鍵：開ける")
        XCTAssertEqual(ActionRules.title(light), "照明")
        XCTAssertEqual(ActionRules.confirmText(unlock), "研究室の鍵：開ける を実行しますか？")
        XCTAssertEqual(ActionRules.confirmText(action("x", "開ける", confirmText: "本当に開けますか？")), "本当に開けますか？")
        XCTAssertEqual(ActionRules.confirmText(action("x", "開ける", confirmText: "  ")), "開ける を実行しますか？")
    }

    func testVisibleOnlyWhileOnWithAButtonAndNeverForAGuest() {
        XCTAssertTrue(ActionRules.visible(list(), role: "member"))
        XCTAssertTrue(ActionRules.visible(list(), role: "manager"))
        XCTAssertTrue(ActionRules.visible(list(), role: "admin"))
        XCTAssertFalse(ActionRules.visible(list(), role: "guest"))
        XCTAssertFalse(ActionRules.visible(list(), role: "bot"))
        XCTAssertFalse(ActionRules.visible(list(), role: nil))
        XCTAssertFalse(ActionRules.visible(list([]), role: "member"))  // on, but nothing I may press
        XCTAssertFalse(ActionRules.visible(list(enabled: false), role: "member"))
        XCTAssertFalse(ActionRules.visible(nil, role: "member"))
        XCTAssertEqual(ActionRules.pressable(list(enabled: false)), [])
        // The 在室状況 placement only when the workspace says so.
        XCTAssertEqual(ActionRules.onAttendance(list()), [])
        XCTAssertEqual(ActionRules.onAttendance(list(onAttendance: true)).count, 4)
        XCTAssertEqual(ActionRules.onAttendance(list(enabled: false, onAttendance: true)), [])
    }

    func testTheStoreKeepsNothingWhileOff() {
        let store = Store()
        store.setActions(list(enabled: false))
        XCTAssertNil(store.actions)
        store.setActions(list())
        XCTAssertEqual(store.actions?.actions.count, 4)
        store.setActions(nil)
        XCTAssertNil(store.actions)
    }

    func testTheTileOnlyWhileVisibleAndInMyOrder() {
        let threads = ThreadSummary(unreadCount: 0, mentionCount: 0)
        let off = HomeTile.tiles(threads: threads, drafts: 0, saved: 0, firedReminders: 0, navItems: nil)
        XCTAssertFalse(off.contains { $0.kind == .actions })
        let on = HomeTile.tiles(threads: threads, drafts: 0, saved: 0, firedReminders: 0, navItems: nil, attendance: 2, actions: true)
        XCTAssertEqual(on.suffix(2).map(\.kind), [.attendance, .actions])  // after 在室状況, as the shared order
        XCTAssertNil(on.last?.count)
        XCTAssertEqual(on.last?.selectionId, ActionsView.selectionId)
        XCTAssertEqual(on.last?.icon, "bolt")
        let hidden = HomeTile.tiles(threads: threads, drafts: 0, saved: 0, firedReminders: 0,
                                    navItems: [NavItem(key: "actions", visible: false)], actions: true)
        XCTAssertFalse(hidden.contains { $0.kind == .actions })
        let first = HomeTile.tiles(threads: threads, drafts: 0, saved: 0, firedReminders: 0,
                                   navItems: [NavItem(key: "actions", visible: true)], actions: true)
        XCTAssertEqual(first.first?.kind, .actions)
        XCTAssertFalse(NavItems.implemented.contains("actions"))
        XCTAssertTrue(NavItems.implemented(attendance: false, actions: true).contains("actions"))
        XCTAssertEqual(NavItems.label("actions"), "操作")
    }

    func testTheTextsAfterAPress() {
        XCTAssertEqual(ActionRules.resultText(out(message: "解錠しました"), action: unlock).text, "解錠しました")
        XCTAssertTrue(ActionRules.resultText(out(message: "解錠しました"), action: unlock).ok)
        XCTAssertEqual(ActionRules.resultText(out(), action: unlock).text, "研究室の鍵：開ける を実行しました")
        let failed = { (error: String?, code: Int?, message: String?) in
            ActionRules.resultText(self.out(ok: false, status: "failed", code: code, error: error, message: message), action: self.unlock)
        }
        XCTAssertEqual(failed("relay_error", 503, "電池が切れています").text, "電池が切れています")
        XCTAssertFalse(failed("relay_error", 503, "電池が切れています").ok)
        XCTAssertEqual(failed("relay_error", 503, nil).text, "実行できませんでした（HTTP 503）")
        XCTAssertEqual(failed("timeout", nil, nil).text, "機器（またはハブ）から応答がありませんでした。実行されたかどうかわかりません。状態を確かめてください")
        XCTAssertEqual(failed("network", nil, nil).text, "機器（またはハブ）に接続できませんでした。オフラインかもしれません")
        XCTAssertEqual(failed("interrupted", nil, nil).text, "送信が途中で止まりました。実行されたかどうかわかりません。状態を確かめてください")
        XCTAssertEqual(failed("secret_missing", nil, nil).text, "このボタンの設定に問題があります。管理者に連絡してください")
        XCTAssertEqual(ActionRules.resultText(out(ok: false, status: "pending", code: nil), action: unlock).text,
                       "まだ処理中です。少し待ってから状態を確かめてください")
    }

    func testRefusalsUseTheSharedErrorTable() {
        XCTAssertEqual(ActionRules.refusalText(ApiError.api(status: 429, code: "rate_limited", message: "x")), "少し待ってからもう一度押してください")
        XCTAssertEqual(ActionRules.refusalText(ApiError.api(status: 403, code: "action_not_allowed", message: "x")), "このボタンを押す権限がありません")
        XCTAssertEqual(ActionRules.refusalText(ApiError.api(status: 409, code: "actions_disabled", message: "x")), "操作ボタンはオフになっています")
        XCTAssertEqual(ActionRules.refusalText(ApiError.api(status: 409, code: "action_disabled", message: "x")), "このボタンは止められています")
        XCTAssertEqual(ActionRules.refusalText(ApiError.api(status: 404, code: "action_not_found", message: "x")), "このボタンは見つかりません")
        XCTAssertEqual(ActionRules.refusalText(ApiError.network(URLError(.notConnectedToInternet))), ErrorMessages.network)
    }

    // MARK: one press per id

    func testANetworkFailureIsSentAgainWithTheSameIdAndOthersAreNot() async throws {
        var ids: [String] = []
        var waits: [Int] = []
        let answer = try await ActionRules.invokeOnce({ id in
            ids.append(id)
            if ids.count < 3 { throw ApiError.network(URLError(.timedOut)) }
            return self.out()
        }, wait: { waits.append($0) })
        XCTAssertTrue(answer.ok)
        XCTAssertEqual(ids.count, 3)  // the first and 2 more
        XCTAssertEqual(Set(ids).count, 1)
        XCTAssertEqual(waits, [1, 2])

        // Never more than 2 retries.
        var tries = 0
        do {
            _ = try await ActionRules.invokeOnce({ _ in tries += 1; throw ApiError.network(URLError(.timedOut)) }, wait: { _ in })
            XCTFail("should throw")
        } catch ApiError.network {}
        XCTAssertEqual(tries, 3)

        // A refusal (429, 403, 5xx) is not retried: a person decides.
        for refusal in [ApiError.api(status: 429, code: "rate_limited", message: "x"), ApiError.api(status: 403, code: "action_not_allowed", message: "x"),
                        ApiError.api(status: 503, code: "http_503", message: "x")] {
            var calls = 0
            do {
                _ = try await ActionRules.invokeOnce({ _ in calls += 1; throw refusal }, wait: { _ in })
                XCTFail("should throw")
            } catch {}
            XCTAssertEqual(calls, 1)
        }

        // A new press is a new id.
        var second = ""
        _ = try await ActionRules.invokeOnce({ id in second = id; return self.out() }, wait: { _ in })
        XCTAssertNotEqual(second, ids[0])
        XCTAssertNotNil(UUID(uuidString: second))
    }

    func testALostAnswerIsAskedAgainAndTheRelayIsCalledOnce() async throws {
        let server = FakeServer()
        let me = server.addUser("me")
        server.actions = list()
        server.relayAnswer = (true, "解錠しました")
        server.actionAnswersLost = 1
        let api = server.api(for: me.id)
        let answer = try await ActionRules.invokeOnce({ id in try await api.invokeAction(id: "a-unlock", clientInvokeId: id) }, wait: { _ in })
        XCTAssertEqual(server.relayCalls, ["a-unlock"])  // once, though asked twice
        XCTAssertTrue(answer.repeated)
        XCTAssertEqual(ActionRules.resultText(answer, action: unlock).text, "解錠しました")
        // A second press is a second call.
        _ = try await ActionRules.invokeOnce({ id in try await api.invokeAction(id: "a-unlock", clientInvokeId: id) }, wait: { _ in })
        XCTAssertEqual(server.relayCalls.count, 2)
    }

    func testPermissionAndDisabledRefusals() async throws {
        let server = FakeServer()
        let guest = server.addUser("guest", role: "guest")
        let me = server.addUser("me")
        server.actions = list()
        do {
            _ = try await server.api(for: guest.id).invokeAction(id: "a-unlock", clientInvokeId: ActionRules.newInvokeId())
            XCTFail("a guest may press nothing")
        } catch {
            XCTAssertEqual(ActionRules.refusalText(error), "このボタンを押す権限がありません")
        }
        server.actions = list(enabled: false)
        do {
            _ = try await ActionRules.invokeOnce({ id in try await server.api(for: me.id).invokeAction(id: "a-unlock", clientInvokeId: id) }, wait: { _ in })
            XCTFail("off")
        } catch {
            XCTAssertEqual(ActionRules.refusalText(error), "操作ボタンはオフになっています")
        }
        XCTAssertEqual(server.relayCalls, [])
    }

    // MARK: the engine

    private func engine(_ server: FakeServer, _ userId: String, _ store: Store) -> SyncEngine {
        var options = EngineOptions()
        options.sleep = { _ in }
        return SyncEngine(api: server.api(for: userId), connect: server.connector(for: userId), wsUrl: URL(string: "ws://fake")!, store: store,
                          getAccessToken: { "t" }, options: options)
    }

    func testBootstrapAndActionsUpdated() async throws {
        let server = FakeServer()
        let me = server.addUser("me")
        server.actions = list([unlock])
        let store = Store()
        let engine = engine(server, me.id, store)
        await engine.start()
        await engine.idle()
        XCTAssertEqual(store.actions?.actions.map(\.id), ["a-unlock"])
        let reads = server.actionReads

        // A burst of actions.updated: one read, 300 ms after the first.
        server.setActionsConfig(list([unlock, lock]))
        server.setActionsConfig(list(onAttendance: true, [unlock, lock, light]))
        await engine.idle()
        try await Task.sleep(for: .milliseconds(400))
        XCTAssertEqual(server.actionReads, reads + 1)
        XCTAssertEqual(store.actions?.actions.count, 3)
        XCTAssertEqual(store.actions?.showOnAttendance, true)

        // Turned off: gone.
        server.setActionsConfig(list(enabled: false))
        await engine.idle()
        try await Task.sleep(for: .milliseconds(400))
        XCTAssertNil(store.actions)
        engine.stop()
    }

    func testAGuestNeverHasTheButtons() async throws {
        let server = FakeServer()
        let guest = server.addUser("guest", role: "guest")
        server.actions = list()
        let store = Store()
        let engine = engine(server, guest.id, store)
        await engine.start()
        await engine.idle()
        XCTAssertNil(store.actions)
        await engine.loadActions()
        XCTAssertEqual(server.actionReads, 0)  // not even asked
        engine.stop()
    }
}
