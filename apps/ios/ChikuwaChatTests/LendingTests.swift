import XCTest
@testable import ChikuwaChat

/// M171 (docs/LENDING.md §12.3, §14): 「備品」 on the phone — decoding (an unknown state never fails the list), the dates
/// of the workspace's zone, the borrow / return / extend / permission requests (one client_request_id per sheet), the
/// 409 when someone was first, the hub's reloads, the tile, the activity row and where a notice opens.
@MainActor
final class LendingTests: XCTestCase {
    // MARK: decoding

    private static let itemsJson = """
    [{"id": "i1", "name": "カメラ A", "category_id": "c1", "code": "CAM-02", "location": "301 棚 2", "notes": "充電器・ケース",
      "photo": {"id": "a1", "filename": "cam.jpg", "content_type": "image/jpeg", "size_bytes": 1000, "width": 640, "height": 480,
                "has_thumbnail": true, "status": "attached", "created_at": "2026-10-20T00:00:00Z"},
      "status": "on_loan", "status_note": null, "requires_permission": true, "requires_permission_source": "category", "max_days": 14,
      "max_days_source": "default",
      "loan": {"id": "l1", "borrower_id": "u2", "borrowed_at": "2026-10-20T01:00:00Z", "due_on": "2026-10-30", "overdue_days": 0,
               "permission_state": null, "status": "active", "returned_at": null, "return_condition": null},
      "watching": true, "created_at": "2026-10-01T00:00:00Z", "updated_at": "2026-10-01T00:00:00Z"},
     {"id": "i2", "name": "三脚", "category_id": null, "code": null, "location": null, "notes": null, "photo": null,
      "status": "lost_somewhere", "status_note": null, "requires_permission": false, "requires_permission_source": "default",
      "max_days": 7, "max_days_source": "item", "loan": null, "watching": false, "created_at": "2026-10-01T00:00:00Z",
      "updated_at": "2026-10-01T00:00:00Z"}]
    """

    func testDecodesTheLedgerAndAnUnknownState() throws {
        let items = try JSON.snakeDecoder.decode([LendingItemOut].self, from: Data(Self.itemsJson.utf8))
        XCTAssertEqual(items.count, 2)
        XCTAssertEqual(items[0].loan?.borrowerId, "u2")
        XCTAssertEqual(items[0].photo?.id, "a1")
        XCTAssertTrue(items[0].watching)
        XCTAssertTrue(items[0].requiresPermission)
        // A state this build does not know shows as it is and is not borrowable.
        XCTAssertEqual(items[1].status, "lost_somewhere")
        XCTAssertEqual(LendingRules.statusLabel(items[1].status), "lost_somewhere")
        XCTAssertFalse(LendingRules.canBorrow(items[1], isGuest: false))
        XCTAssertEqual(LendingRules.statusColor("lost_somewhere"), .gray)
    }

    func testDecodesALoanWithItsDetailsHidden() throws {
        let json = """
        {"id": "l1", "item_id": "i1", "item_name": "カメラ A", "item_code": "CAM-02", "borrower_id": "u2", "status": "active",
         "borrowed_at": "2026-10-20T01:00:00Z", "due_on": "2026-10-30", "original_due_on": "2026-10-30", "overdue_days": 0,
         "extension_count": 1, "can_extend": false, "latest_due_on": "2026-11-09", "purpose": null, "permission_required": true,
         "approver_id": null, "permission_state": null, "permission_decided_at": null, "permission_note": null, "returned_at": null,
         "returned_by": null, "return_condition": null, "return_note": null, "details_hidden": true}
        """
        let loan = try JSON.snakeDecoder.decode(LendingLoanOut.self, from: Data(json.utf8))
        XCTAssertTrue(loan.detailsHidden)
        XCTAssertNil(loan.purpose)
        XCTAssertEqual(loan.latestDueOn, "2026-11-09")
        XCTAssertTrue(loan.isActive)
        // Not the teacher (hidden): no buttons.
        XCTAssertEqual(LendingRules.decisions(loan, me: "u9"), [])
    }

    func testDecodesTheBootstrapSummaryAndTheActivityItem() throws {
        let summary = try JSON.snakeDecoder.decode(LendingSummaryOut.self, from: Data("""
        {"enabled": true, "is_keeper": true, "my_active_count": 2, "my_overdue_count": 1, "keeper_attention_count": 3,
         "settings_updated_at": "2026-10-26T00:00:00Z"}
        """.utf8))
        XCTAssertEqual(summary.keeperAttentionCount, 3)
        let page = try JSON.snakeDecoder.decode(ActivityListOut.self, from: Data("""
        {"items": [{"id": "n1", "kind": "lending", "at": "2026-10-26T00:00:00Z", "actor_ids": [], "read": false,
                    "lending": {"item_id": "n1", "lending_item_id": "i1", "loan_id": "l1", "item_name": "カメラ A", "role": "approver",
                                "text": "🔑 山田 さんが「カメラ A（CAM-02）」を借りました", "done": false, "done_at": null, "done_by": null}},
                   {"id": "n2", "kind": "lending", "at": "2026-10-26T00:00:00Z", "actor_ids": [],
                    "lending": {"item_id": "n2", "lending_item_id": null, "loan_id": null, "item_name": null, "role": "keeper",
                                "text": "⏰ 返す日を 3 日以上過ぎた貸し出しが 2 件あります", "done": false, "done_at": null, "done_by": null}}],
         "next_cursor": null, "read_at": "2026-10-25T00:00:00Z"}
        """.utf8))
        let rows = ActivityRules.append([], page.items)
        XCTAssertEqual(rows.map(\.id), ["lending:n1", "lending:n2"])
        XCTAssertEqual(rows[0].itemId, "n1")
        XCTAssertTrue(rows[0].lending?.isOpenApproval == true)
        XCTAssertFalse(rows[1].lending?.isOpenApproval == true)
        XCTAssertEqual(ActivityRules.headline(rows[0], nameOf: { $0 }).who, "カメラ A")
        XCTAssertEqual(ActivityRules.headline(rows[1], nameOf: { $0 }).who, "備品")
        XCTAssertEqual(ActivityRules.excerpt(rows[1], users: [:]), "⏰ 返す日を 3 日以上過ぎた貸し出しが 2 件あります")
        // activity.updated naming the teacher's to-do: done (no dot, 「対応済み」).
        let done = ActivityRules.blankingExcerpts(rows, itemIds: ["n1"])
        XCTAssertTrue(ActivityRules.isDone(done[0]))
        XCTAssertFalse(ActivityRules.isDone(done[1]))
        XCTAssertTrue(ApiClient.activityInclude.contains("lending"))
    }

    // MARK: dates (the workspace's zone)

    func testTodayAndTheBorrowRangeAreTheWorkspaceZones() {
        // 2026-10-26 15:30 UTC is already 10/27 in Tokyo.
        let now = parseIsoDate("2026-10-26T15:30:00Z")!
        XCTAssertEqual(LendingRules.today(now: now, tz: "Asia/Tokyo"), "2026-10-27")
        XCTAssertEqual(LendingRules.today(now: now, tz: "UTC"), "2026-10-26")
        XCTAssertEqual(LendingRules.borrowRange(maxDays: 14, now: now, tz: "Asia/Tokyo"), "2026-10-27"..."2026-11-10")
        XCTAssertEqual(LendingRules.borrowRange(maxDays: 0, now: now, tz: "Asia/Tokyo"), "2026-10-27"..."2026-10-27")
        // A day picked in the zone's calendar is that day, whatever the phone's zone.
        let cal = LendingRules.calendar(tz: "Asia/Tokyo")
        let start = LendingRules.date("2026-11-10", calendar: cal)!
        XCTAssertEqual(LendingRules.day(start, calendar: cal), "2026-11-10")
        XCTAssertEqual(LendingRules.adding(1, to: "2026-10-31", calendar: cal), "2026-11-01")
    }

    func testTheExtendRange() {
        let now = parseIsoDate("2026-10-26T03:00:00Z")!  // 10/26 in Tokyo
        var loan = LendingLoanOut(id: "l1", itemId: "i1", itemName: "x", borrowerId: "me", dueOn: "2026-10-30", canExtend: true,
                                  latestDueOn: "2026-11-09")
        XCTAssertEqual(LendingRules.extendRange(loan, now: now, tz: "Asia/Tokyo"), "2026-10-31"..."2026-11-09")
        // Overdue: from today, not from the day after the old date.
        loan = LendingLoanOut(id: "l1", itemId: "i1", itemName: "x", borrowerId: "me", dueOn: "2026-10-20", overdueDays: 6,
                              canExtend: true, latestDueOn: "2026-11-09")
        XCTAssertEqual(LendingRules.extendRange(loan, now: now, tz: "Asia/Tokyo"), "2026-10-26"..."2026-11-09")
        // Nothing later is allowed.
        loan = LendingLoanOut(id: "l1", itemId: "i1", itemName: "x", borrowerId: "me", dueOn: "2026-11-09", latestDueOn: "2026-11-09")
        XCTAssertNil(LendingRules.extendRange(loan, now: now, tz: "Asia/Tokyo"))
        XCTAssertEqual(LendingRules.extensionsLeft(LendingLoanOut(id: "l", itemId: "i", itemName: "x", borrowerId: "me", dueOn: "2026-10-30",
                                                                  extensionCount: 1), settings: LendingSettingsOut(enabled: true, maxExtensions: 2)), 1)
    }

    func testTheDueWords() {
        XCTAssertEqual(LendingRules.shortDay("2026-10-30"), "10/30 (金)")
        XCTAssertEqual(LendingRules.dueText(dueOn: "2026-10-30", overdueDays: 0, today: "2026-10-26"), "10/30 (金) まで")
        XCTAssertEqual(LendingRules.dueText(dueOn: "2026-10-26", overdueDays: 0, today: "2026-10-26"), "今日まで")
        XCTAssertEqual(LendingRules.dueText(dueOn: "2026-10-24", overdueDays: 2, today: "2026-10-26"), "10/24 (土) まで · 2 日過ぎ")
        XCTAssertEqual(LendingRules.maxText(maxDays: 14, latest: "2026-11-09"), "最長 14 日（11/9 (月) まで）")
        XCTAssertEqual(LendingRules.itemTitle(name: "カメラ A", code: "CAM-02"), "カメラ A（CAM-02）")
        XCTAssertEqual(LendingRules.itemTitle(name: "三脚", code: nil), "三脚")
    }

    // MARK: the list

    func testTheLocalFilters() throws {
        let items = try JSON.snakeDecoder.decode([LendingItemOut].self, from: Data(Self.itemsJson.utf8))
        XCTAssertEqual(LendingRules.filter(items, query: "cam-02", categoryId: nil, status: nil).map(\.id), ["i1"])
        XCTAssertEqual(LendingRules.filter(items, query: "ＣＡＭ", categoryId: nil, status: nil).map(\.id), ["i1"]) // full width
        XCTAssertEqual(LendingRules.filter(items, query: "301", categoryId: "c1", status: "on_loan").map(\.id), ["i1"])
        XCTAssertEqual(LendingRules.filter(items, query: "", categoryId: "c1", status: "available").map(\.id), [])
        XCTAssertEqual(LendingRules.filter(items, query: "", categoryId: nil, status: nil).count, 2)
        XCTAssertEqual(LendingRules.subtitle(items[0], categories: [LendingCategoryOut(id: "c1", name: "カメラ")]), "CAM-02 · カメラ · 301 棚 2")
        // Watching: not my own loan, not retired.
        XCTAssertTrue(LendingRules.canWatch(items[0], me: "me"))
        XCTAssertFalse(LendingRules.canWatch(items[0], me: "u2"))
    }

    func testTheTeachersButtonsAndTheBorrowSheetsChecks() {
        let claimed = LendingLoanOut(id: "l1", itemId: "i1", itemName: "x", borrowerId: "u2", dueOn: "2026-10-30", permissionRequired: true,
                                     approverId: "t1", permissionState: "claimed")
        XCTAssertEqual(LendingRules.decisions(claimed, me: "t1"), ["denied", "confirmed"])
        XCTAssertEqual(LendingRules.decisions(claimed, me: "admin"), []) // administrators and keepers cannot press for them
        var confirmed = claimed
        confirmed.permissionState = "confirmed"
        XCTAssertEqual(LendingRules.decisions(confirmed, me: "t1"), ["denied"])
        var denied = claimed
        denied.permissionState = "denied"
        XCTAssertEqual(LendingRules.decisions(denied, me: "t1"), ["confirmed"])

        XCTAssertFalse(LendingRules.borrowReady(purpose: "  ", needsPermission: false, selfApproved: false, ticked: false, approverId: nil))
        XCTAssertTrue(LendingRules.borrowReady(purpose: "撮影", needsPermission: false, selfApproved: false, ticked: false, approverId: nil))
        XCTAssertFalse(LendingRules.borrowReady(purpose: "撮影", needsPermission: true, selfApproved: false, ticked: true, approverId: nil))
        XCTAssertFalse(LendingRules.borrowReady(purpose: "撮影", needsPermission: true, selfApproved: false, ticked: false, approverId: "t1"))
        XCTAssertTrue(LendingRules.borrowReady(purpose: "撮影", needsPermission: true, selfApproved: false, ticked: true, approverId: "t1"))
        XCTAssertTrue(LendingRules.borrowReady(purpose: "撮影", needsPermission: true, selfApproved: true, ticked: false, approverId: nil))
        XCTAssertFalse(LendingRules.borrowReady(purpose: String(repeating: "あ", count: 201), needsPermission: false, selfApproved: false,
                                                ticked: false, approverId: nil))
        XCTAssertFalse(LendingRules.returnReady(condition: "issue", note: " "))
        XCTAssertTrue(LendingRules.returnReady(condition: "issue", note: "キャップ無し"))
        XCTAssertTrue(LendingRules.returnReady(condition: "ok", note: ""))

        let names = ["t1": "鈴木", "t2": "加納", "t3": "青木"]
        let order = LendingRules.approvers(LendingApproversOut(userIds: ["t1", "t2", "t3"], suggestedIds: ["t2"]), name: { names[$0] ?? $0 })
        XCTAssertEqual(order.first, "t2") // my supervisor first
        XCTAssertEqual(Set(order), ["t1", "t2", "t3"])
    }

    // MARK: requests

    private func makeClient() -> ApiClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubProtocol.self]
        let client = ApiClient(baseUrl: URL(string: "http://server")!, session: URLSession(configuration: configuration))
        client.accessToken = "t"
        return client
    }

    private static func body(_ request: URLRequest) -> JSONValue? {
        guard let stream = request.httpBodyStream else { return nil }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: buffer.count)
            if read <= 0 { break }
            data.append(buffer, count: read)
        }
        return try? JSONDecoder().decode(JSONValue.self, from: data)
    }

    private static let loanJson = """
    {"id": "l1", "item_id": "i1", "item_name": "カメラ A", "item_code": "CAM-02", "borrower_id": "me", "status": "active",
     "borrowed_at": "2026-10-26T01:00:00Z", "due_on": "2026-10-30", "original_due_on": "2026-10-30", "overdue_days": 0,
     "extension_count": 0, "can_extend": true, "latest_due_on": "2026-11-09", "purpose": "撮影", "permission_required": true,
     "approver_id": "t1", "permission_state": "claimed", "permission_decided_at": null, "permission_note": null, "returned_at": null,
     "returned_by": null, "return_condition": null, "return_note": null, "details_hidden": false}
    """

    func testTheRequestsAndTheRetryKeepsItsKey() async throws {
        var requests: [(request: URLRequest, body: JSONValue?)] = []
        var dropFirst = true
        StubProtocol.handler = { request in
            requests.append((request, Self.body(request)))
            if request.httpMethod == "PUT" || request.httpMethod == "DELETE" { return (204, Data()) }
            if request.url!.path.hasSuffix("/borrow") {
                if dropFirst {  // the answer is lost on the way: the phone sends again
                    dropFirst = false
                    return (-1, Data())
                }
                return (200, Data(Self.loanJson.utf8))  // the server's answer to a retry: the same loan
            }
            if request.url!.path == "/api/v1/lending/loans" { return (200, Data("[\(Self.loanJson)]".utf8)) }
            return (200, Data(Self.loanJson.utf8))
        }
        defer { StubProtocol.handler = nil }
        let client = makeClient()
        let form = LendingBorrowForm(clientRequestId: "11111111-2222-3333-4444-555555555555", dueOn: "2026-10-30", purpose: "撮影",
                                     permissionConfirmed: true, approverId: "t1")
        do {
            _ = try await client.borrowLending(itemId: "i1", form: form)
            XCTFail("the first answer was lost")
        } catch let error as ApiError {
            XCTAssertTrue(error.isRetryable)
        }
        let loan = try await client.borrowLending(itemId: "i1", form: form)
        XCTAssertEqual(loan.id, "l1")
        let borrows = requests.filter { $0.request.url!.path == "/api/v1/lending/items/i1/borrow" }
        XCTAssertEqual(borrows.count, 2)
        let expected: JSONValue = .object(["client_request_id": .string("11111111-2222-3333-4444-555555555555"), "due_on": .string("2026-10-30"),
                                           "purpose": .string("撮影"), "permission_confirmed": .bool(true), "approver_id": .string("t1")])
        XCTAssertEqual(borrows[0].body, expected)
        XCTAssertEqual(borrows[1].body, expected) // the same key: never a second loan

        _ = try await client.returnLending(loanId: "l1", condition: "issue", note: "キャップ無し")
        XCTAssertEqual(requests.last?.request.url?.path, "/api/v1/lending/loans/l1/return")
        XCTAssertEqual(requests.last?.body, .object(["condition": .string("issue"), "note": .string("キャップ無し")]))
        _ = try await client.extendLending(loanId: "l1", dueOn: "2026-11-05")
        XCTAssertEqual(requests.last?.request.url?.path, "/api/v1/lending/loans/l1/extend")
        XCTAssertEqual(requests.last?.body, .object(["due_on": .string("2026-11-05")]))
        _ = try await client.decideLending(loanId: "l1", decision: "denied", note: nil)
        XCTAssertEqual(requests.last?.request.url?.path, "/api/v1/lending/loans/l1/permission")
        XCTAssertEqual(requests.last?.body, .object(["decision": .string("denied")]))
        try await client.watchLending(itemId: "i1", on: true)
        XCTAssertEqual(requests.last?.request.httpMethod, "PUT")
        XCTAssertEqual(requests.last?.request.url?.path, "/api/v1/lending/items/i1/watch")
        try await client.watchLending(itemId: "i1", on: false)
        XCTAssertEqual(requests.last?.request.httpMethod, "DELETE")
        _ = try await client.lendingLoans(scope: "approved")
        XCTAssertEqual(requests.last?.request.url?.absoluteString, "http://server/api/v1/lending/loans?scope=approved")
    }

    func testSomeoneElseWasFirst() async throws {
        StubProtocol.handler = { _ in
            (409, Data("""
            {"error": {"code": "lending_item_unavailable", "message": "taken",
                       "details": {"status": "on_loan", "loan_id": "l9", "borrower_id": "u2", "due_on": "2026-10-30"}}}
            """.utf8))
        }
        defer { StubProtocol.handler = nil }
        let client = makeClient()
        do {
            _ = try await client.borrowLending(itemId: "i1", form: LendingBorrowForm(clientRequestId: "k", dueOn: "2026-10-30", purpose: "x"))
            XCTFail("409")
        } catch let taken as LendingUnavailable {
            XCTAssertEqual(taken, LendingUnavailable(status: "on_loan", borrowerId: "u2", dueOn: "2026-10-30"))
            XCTAssertEqual(LendingRules.errorText(taken, me: "me", name: { $0 == "u2" ? "山田" : "?" }), "山田 さんが先に借りました（10/30 (金) まで）")
            XCTAssertEqual(LendingRules.errorText(taken, me: "u2", name: { _ in "" }), "すでに借りています")
        }
        XCTAssertEqual(LendingRules.errorText(LendingUnavailable(status: "in_repair"), me: "me", name: { $0 }), "この備品は今は借りられません（修理中）")
        // Other refusals: the shared texts.
        XCTAssertEqual(LendingRules.errorText(ApiError.api(status: 409, code: "lending_extend_limit", message: ""), me: nil, name: { $0 }),
                       ErrorMessages.byCode["lending_extend_limit"])
    }

    // MARK: the hub

    func testTheHubFollowsBootstrapEventsAndPresses() async throws {
        let api = FakeLendingApi()
        let hub = LendingHub(api: api)
        hub.debounce = .zero
        XCTAssertFalse(hub.enabled)
        hub.bootstrap(LendingSummaryOut(enabled: true, isKeeper: false, myActiveCount: 1, myOverdueCount: 1, keeperAttentionCount: 0))
        XCTAssertTrue(hub.enabled)
        XCTAssertEqual(hub.tileCount, 1)
        try await waitUntil { hub.settings != nil }
        XCTAssertEqual(hub.tz, "Asia/Tokyo")

        // My loan came back: the tile follows the loans read after lending.updated.
        api.mine = []
        let before = hub.changes
        hub.applyUpdated(.object(["item_ids": .array([.string("i1")]), "categories": .bool(false), "settings": .bool(false)]))
        try await waitUntil { hub.changes > before }
        XCTAssertEqual(hub.tileCount, 0)
        XCTAssertEqual(hub.myLoans, [])

        // Someone was first: the press fails with who, and the list reads again.
        await hub.loadItems()
        XCTAssertEqual(hub.items?.count, 1)
        api.borrowError = LendingUnavailable(status: "on_loan", borrowerId: "u2", dueOn: "2026-10-30")
        let reads = api.itemReads
        do {
            _ = try await hub.borrow(itemId: "i1", form: LendingBorrowForm(clientRequestId: "k", dueOn: "2026-10-30", purpose: "x"))
            XCTFail("409")
        } catch is LendingUnavailable {}
        try await waitUntil { api.itemReads > reads }

        // Turned off (the settings changed): no tile.
        api.settings = LendingSettingsOut(enabled: false)
        hub.applyUpdated(.object(["settings": .bool(true)]))
        try await waitUntil { hub.settings?.enabled == false }
        XCTAssertFalse(hub.enabled)

        // A guest never reads.
        let guestApi = FakeLendingApi()
        let guest = LendingHub(api: guestApi)
        guest.isPerson = { false }
        guest.bootstrap(nil)
        guest.applyUpdated(.object(["settings": .bool(true)]))
        await guest.loadItems()
        XCTAssertFalse(guest.enabled)
        XCTAssertEqual(guestApi.itemReads, 0)
    }

    func testTheKeepersAttention() {
        let loans = [
            LendingLoanOut(id: "a", itemId: "i", itemName: "x", borrowerId: "u1", dueOn: "2026-10-20", overdueDays: 5),
            LendingLoanOut(id: "b", itemId: "i", itemName: "x", borrowerId: "u2", dueOn: "2026-10-24", overdueDays: 1),
            LendingLoanOut(id: "c", itemId: "i", itemName: "x", borrowerId: "gone", dueOn: "2026-11-24", overdueDays: 0),
        ]
        XCTAssertEqual(LendingRules.keeperAttention(loans, keeperOverdueDays: 3, deactivated: { $0 == "gone" }), 2)
        XCTAssertEqual(LendingRules.tileCount(myOverdue: 1, keeperAttention: 2, isKeeper: true), 3)
        XCTAssertEqual(LendingRules.tileCount(myOverdue: 1, keeperAttention: 2, isKeeper: false), 1)
    }

    private func waitUntil(_ condition: @escaping () -> Bool, timeout: TimeInterval = 2) async throws {
        let end = Date().addingTimeInterval(timeout)
        while !condition() {
            if Date() > end { XCTFail("timed out"); return }
            try await Task.sleep(for: .milliseconds(10))
        }
    }

    // MARK: the tile, notices and navigation

    func testTheTileFollowsReservationsAndOnlyWhileOn() {
        let threads = ThreadSummary(unreadCount: 0, mentionCount: 0)
        let off = HomeTile.tiles(threads: threads, drafts: 0, saved: 0, firedReminders: 0, navItems: nil)
        XCTAssertFalse(off.contains { $0.kind == .lending })
        let on = HomeTile.tiles(threads: threads, drafts: 0, saved: 0, firedReminders: 0, navItems: nil,
                                reservations: HomeTile.ReservationTile(todos: 0, operates: false), lending: 2)
        let kinds = on.map(\.kind)
        XCTAssertEqual(kinds.firstIndex(of: .lending), kinds.firstIndex(of: .reservations).map { $0 + 1 })
        let tile = on.first { $0.kind == .lending }!
        XCTAssertEqual(tile.count, 2)
        XCTAssertTrue(tile.alert)
        XCTAssertEqual(tile.title, "備品")
        XCTAssertEqual(tile.selectionId, LendingView.selectionId)
        // Nothing overdue: no number, not dimmed.
        let quiet = HomeTile.tiles(threads: threads, drafts: 0, saved: 0, firedReminders: 0, navItems: nil, lending: 0).first { $0.kind == .lending }!
        XCTAssertNil(quiet.count)
        XCTAssertFalse(quiet.dimmed)
        // Hidden by me: not drawn.
        let hidden = HomeTile.tiles(threads: threads, drafts: 0, saved: 0, firedReminders: 0, navItems: [NavItem(key: "lending", visible: false)],
                                    lending: 1)
        XCTAssertFalse(hidden.contains { $0.kind == .lending })
        XCTAssertTrue(NavItems.implemented(attendance: false, lending: true).contains("lending"))
        XCTAssertFalse(NavItems.implemented.contains("lending"))
    }

    func testAPushOpensTheLoanThenTheItemThenTheOverdueList() {
        let loan = PushPayload(userInfo: ["kind": "lending", "lending_item_id": "i1", "loan_id": "l1", "workspace_id": "w"])
        XCTAssertTrue(loan.opensLending)
        XCTAssertEqual(LendingRules.target(loanId: loan.loanId, itemId: loan.lendingItemId), .loan("l1"))
        let repaired = PushPayload(userInfo: ["kind": "lending", "lending_item_id": "i1"])
        XCTAssertEqual(LendingRules.target(loanId: repaired.loanId, itemId: repaired.lendingItemId), .item("i1"))
        let summary = PushPayload(userInfo: ["kind": "lending"])
        XCTAssertEqual(LendingRules.target(loanId: summary.loanId, itemId: summary.lendingItemId), .overdue)
        XCTAssertFalse(PushPayload(userInfo: ["kind": "reservation"]).opensLending)
        XCTAssertTrue(Workspaces.shouldPresent(loan, target: nil, active: nil, openChannelId: "c1"))

        var nav = MainNavigation()
        nav.tab = .dms
        nav.landLending(.loan("l1"), listId: LendingView.selectionId)
        XCTAssertEqual(nav.tab, .home)
        XCTAssertEqual(nav.paths[.home], [.list(LendingView.selectionId), .lending(.loan("l1"))])
        var split = MainNavigation()
        split.layout = .split
        split.youSheet = true
        split.landLending(.overdue, listId: LendingView.selectionId)
        XCTAssertEqual(split.split, [.list(LendingView.selectionId), .lending(.overdue)])
        XCTAssertFalse(split.youSheet)
    }
}

/// The equipment calls answered from memory.
@MainActor
final class FakeLendingApi: LendingApi {
    var settings = LendingSettingsOut(enabled: true, tz: "Asia/Tokyo")
    var items = [LendingItemOut(id: "i1", name: "カメラ A", status: "available")]
    var mine = [LendingLoanOut(id: "l1", itemId: "i1", itemName: "カメラ A", borrowerId: "me", dueOn: "2026-10-20", overdueDays: 6)]
    var borrowError: Error?
    private(set) var itemReads = 0

    func lendingSettings() async throws -> LendingSettingsOut { settings }
    func lendingCategories() async throws -> [LendingCategoryOut] { [] }
    func lendingItems() async throws -> [LendingItemOut] {
        itemReads += 1
        return items
    }
    func lendingItem(_ id: String) async throws -> LendingItemOut {
        guard let item = items.first(where: { $0.id == id }) else { throw ApiError.api(status: 404, code: "lending_item_not_found", message: "") }
        return item
    }
    func lendingLoans(scope: String) async throws -> [LendingLoanOut] { scope == "mine" ? mine : [] }
    func lendingLoan(_ id: String) async throws -> LendingLoanOut {
        guard let loan = mine.first(where: { $0.id == id }) else { throw ApiError.api(status: 404, code: "lending_loan_not_found", message: "") }
        return loan
    }
    func lendingApprovers() async throws -> LendingApproversOut { LendingApproversOut() }
    func borrowLending(itemId: String, form: LendingBorrowForm) async throws -> LendingLoanOut {
        if let borrowError { throw borrowError }
        return LendingLoanOut(id: "new", itemId: itemId, itemName: "x", borrowerId: "me", dueOn: form.dueOn)
    }
    func returnLending(loanId: String, condition: String, note: String?) async throws -> LendingLoanOut {
        LendingLoanOut(id: loanId, itemId: "i1", itemName: "x", borrowerId: "me", status: "returned", dueOn: "2026-10-30")
    }
    func extendLending(loanId: String, dueOn: String) async throws -> LendingLoanOut {
        LendingLoanOut(id: loanId, itemId: "i1", itemName: "x", borrowerId: "me", dueOn: dueOn)
    }
    func decideLending(loanId: String, decision: String, note: String?) async throws -> LendingLoanOut {
        LendingLoanOut(id: loanId, itemId: "i1", itemName: "x", borrowerId: "u2", dueOn: "2026-10-30", permissionRequired: true,
                       approverId: "me", permissionState: decision)
    }
    func watchLending(itemId: String, on: Bool) async throws {}
}
