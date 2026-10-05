import XCTest
@testable import ChikuwaChat

/// M112 (docs/RESERVATIONS.md §6): 「予約」 — decoding, the booking choices, the day's hours, the words, the tile, the
/// activity item and live reloads.
@MainActor
final class ReservationTests: XCTestCase {
    private var tokyo: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Asia/Tokyo")!
        return calendar
    }

    /// 2026-10-05 (月) 10:20 in Tokyo.
    private let now = parseIsoDate("2026-10-05T01:20:00Z")!

    /// An hour of 2026-10-05 in Tokyo as ISO (UTC).
    private func at(_ hour: Int, day: Int = 5) -> String {
        let date = tokyo.date(from: DateComponents(year: 2026, month: 10, day: day, hour: hour))!
        return ISO8601DateFormatter().string(from: date)
    }

    private func booking(_ id: String, user: String, from: Int, to: Int, status: String = "booked") -> ReservationOut {
        ReservationOut(id: id, userId: user, kind: "booking", status: status, requestedAt: "2026-10-04T00:00:00Z", startAt: at(from), endAt: at(to))
    }

    func testDecodesTheServersPool() throws {
        let json = """
        {"id": "p1", "name": "シート", "capacity": 3, "min_hours": 6, "max_hours": 4, "grace_minutes": 15, "tz": "Asia/Tokyo",
         "enabled": true, "operator_ids": ["u9"], "log_channel_id": null, "visibility": "group", "visibility_channel_id": null,
         "visibility_group_id": "g1",
         "holders": [{"id": "r1", "user_id": "u1", "kind": "walkin", "status": "holding", "requested_at": "2026-10-04T00:00:00Z",
                      "start_at": null, "end_at": null, "assigned_at": "2026-10-04T00:10:00Z", "guarantee_until": "2026-10-04T06:10:00Z",
                      "returned_at": null, "evict_at": null, "email": "a@example.jp", "position": null, "step": null, "pair_id": null,
                      "ready": false, "until": null, "can_extend": false}],
         "waiting": [],
         "bookings": [{"id": "b1", "user_id": "u2", "kind": "booking", "status": "booked", "requested_at": "2026-10-04T01:00:00Z",
                       "start_at": "2026-10-05T04:00:00Z", "end_at": "2026-10-05T06:00:00Z", "assigned_at": null, "guarantee_until": null,
                       "returned_at": null, "evict_at": null, "email": null, "position": null, "step": null, "pair_id": null,
                       "ready": false, "until": null, "can_extend": true}],
         "todos": [{"key": "booking:b1", "action": "assign", "reason": "free", "assign_id": "b1", "remove_id": null,
                    "due_at": "2026-10-05T04:00:00Z", "upcoming": true}],
         "next_evict_id": null, "my_reservation_id": null, "can_manage": false, "can_operate": true, "horizon_days": 14,
         "created_at": "2026-10-01T00:00:00Z", "updated_at": "2026-10-01T00:00:00Z"}
        """
        let pool = try JSON.snakeDecoder.decode(PoolOut.self, from: Data(json.utf8))
        XCTAssertEqual(pool.maxHours, 4)
        XCTAssertEqual(pool.visibility, "group")
        XCTAssertEqual(pool.bookings.first?.canExtend, true)
        XCTAssertEqual(pool.todos.first?.upcoming, true)
        XCTAssertEqual(ReservationRules.todoCount([pool]), 0) // only due to-dos count
    }

    func testStartsDurationsAndHours() {
        let pool = PoolOut(id: "p1", name: "シート", capacity: 2, bookings: [booking("b1", user: "a", from: 12, to: 15), booking("b2", user: "b", from: 13, to: 14)])
        let day = tokyo.startOfDay(for: now)
        let starts = ReservationRules.starts(pool, day: day, now: now, calendar: tokyo)
        XCTAssertEqual(starts.first.map { ReservationRules.hm($0.start, calendar: tokyo) }, "10:00")
        XCTAssertEqual(starts.first { ReservationRules.hm($0.start, calendar: tokyo) == "13:00" }?.full, true)
        let ten = tokyo.date(bySettingHour: 10, minute: 0, second: 0, of: now)!
        XCTAssertEqual(ReservationRules.durations(pool, start: ten, now: now, calendar: tokyo), [1, 2, 3])
        let hours = ReservationRules.hours(pool, day: day, now: now, calendar: tokyo)
        XCTAssertEqual(hours.count, 24)
        XCTAssertEqual(hours[13].rows.map(\.id), ["b1", "b2"])
        XCTAssertEqual(hours[15].rows, [])
        XCTAssertEqual(ReservationRules.bookingDays(now: now, horizonDays: 14, calendar: tokyo).count, 15)
        XCTAssertEqual(ReservationRules.dayLabel(tokyo.date(byAdding: .day, value: 2, to: day)!, now: now, calendar: tokyo), "10/7 (水)")
        // a walk-in's guarantee holds its hours
        let walk = ReservationOut(id: "w", userId: "c", kind: "walkin", status: "holding", requestedAt: at(8), assignedAt: at(9), guaranteeUntil: at(11))
        let one = PoolOut(id: "p2", name: "x", capacity: 1, holders: [walk])
        XCTAssertFalse(ReservationRules.fits(one, start: ten, hours: 1, now: now))
        XCTAssertTrue(ReservationRules.fits(one, start: ten.addingTimeInterval(3600), hours: 1, now: now))
    }

    func testTheDefaultLengthIsTheMaximumOrTheLongestThatFits() {
        let pool = PoolOut(id: "p1", name: "シート", capacity: 2, bookings: [booking("b1", user: "a", from: 12, to: 15), booking("b2", user: "b", from: 13, to: 14)])
        let ten = tokyo.date(bySettingHour: 10, minute: 0, second: 0, of: now)!
        let full = ReservationRules.durationDefault(pool, start: ten, now: now, calendar: tokyo)
        XCTAssertEqual(full, .init(hours: 3, limit: .full, at: parseIsoDate(at(13))))
        XCTAssertEqual(ReservationRules.limitText(full, pool: pool, start: ten, calendar: tokyo), "13:00 から埋まっているため、最長 3 時間です")
        let two = ten.addingTimeInterval(4 * 3600)
        let max = ReservationRules.durationDefault(pool, start: two, now: now, calendar: tokyo)
        XCTAssertEqual(max, .init(hours: 6, limit: .max, at: nil))
        XCTAssertNil(ReservationRules.limitText(max, pool: pool, start: two, calendar: tokyo))
        // the last day: the two weeks end at midnight
        let last = tokyo.date(from: DateComponents(year: 2026, month: 10, day: 19, hour: 22))!
        let horizon = ReservationRules.durationDefault(pool, start: last, now: now, calendar: tokyo)
        XCTAssertEqual(horizon.hours, 2)
        XCTAssertEqual(horizon.limit, .horizon)
        XCTAssertEqual(ReservationRules.limitText(horizon, pool: pool, start: last, calendar: tokyo), "予約は 14 日先までのため、最長 2 時間です")
    }

    func testOneActiveReservationPerPool() {
        let mine = booking("m1", user: "me", from: 16, to: 18)
        let other = booking("b1", user: "a", from: 12, to: 15)
        XCTAssertEqual(ReservationRules.active(PoolOut(id: "p", name: "x", capacity: 2, bookings: [other, mine], myActiveId: "m1"), me: "me")?.id, "m1")
        XCTAssertEqual(ReservationRules.active(PoolOut(id: "p", name: "x", capacity: 2, bookings: [other, mine]), me: "me")?.id, "m1")
        XCTAssertNil(ReservationRules.active(PoolOut(id: "p", name: "x", capacity: 2, bookings: [other]), me: "me"))
        let waiting = ReservationOut(id: "q1", userId: "me", kind: "walkin", status: "waiting", requestedAt: at(9))
        XCTAssertEqual(ReservationRules.active(PoolOut(id: "p", name: "x", capacity: 2, waiting: [waiting]), me: "me")?.id, "q1")
        XCTAssertEqual(ReservationRules.activeText(waiting, now: now), "今すぐ · 順番待ち")
        XCTAssertTrue(ReservationRules.activeText(mine, now: now).hasPrefix("予約 "))
        XCTAssertTrue(ReservationRules.activeText(booking("m2", user: "me", from: 16, to: 18, status: "holding"), now: now).hasSuffix(" · 利用中"))
    }

    func testWordsTodosAndTheTile() {
        let waiting = ReservationOut(id: "q1", userId: "me", kind: "walkin", status: "waiting", requestedAt: at(9), email: "me@example.jp",
                                     position: 1, step: "assign", until: at(13))
        let holder = ReservationOut(id: "w1", userId: "bob", kind: "walkin", status: "holding", requestedAt: at(8), assignedAt: at(9),
                                    guaranteeUntil: at(12))
        let todos = [
            ReservationTodo(key: "assign:q1", action: "assign", reason: "free", assignId: "q1", dueAt: at(10)),
            ReservationTodo(key: "booking:b1", action: "swap", reason: "guarantee_over", assignId: "b1", removeId: "w1", dueAt: at(12), upcoming: true),
        ]
        let pool = PoolOut(id: "p1", name: "シート", capacity: 1, holders: [holder], waiting: [waiting],
                           bookings: [booking("b1", user: "alice", from: 12, to: 15)], todos: todos, myReservationId: "q1", canOperate: true)
        let name: (String) -> String = { ["me": "わたし", "bob": "ボブ", "alice": "アリス"][$0] ?? "?" }
        XCTAssertEqual(ReservationRules.mine(pool, me: "me").walkin?.id, "q1")
        XCTAssertTrue(ReservationRules.walkinText(waiting, pool: pool, now: now).hasPrefix("空きあり (〜"))
        XCTAssertEqual(ReservationRules.todoLine(todos[0], pool: pool, name: name, now: now), "わたし さん (me@example.jp) に割り当てる")
        XCTAssertTrue(ReservationRules.todoLine(todos[1], pool: pool, name: name, now: now).contains("ボブ さん を外して アリス さん に割り当てる (保証時間が終了)"))
        XCTAssertEqual(ReservationRules.todoCount([pool]), 1)
        let tiles = HomeTile.tiles(threads: ThreadSummary(unreadCount: 0, mentionCount: 0), drafts: 0, saved: 0, firedReminders: 0,
                                   reservations: HomeTile.ReservationTile(todos: 1, operates: true))
        let tile = tiles.first { $0.kind == .reservations }
        XCTAssertEqual(tile?.count, 1)
        XCTAssertEqual(tile?.alert, true)
        XCTAssertEqual(tiles.firstIndex { $0.kind == .reservations }, (tiles.firstIndex { $0.kind == .deadlines } ?? 0) + 1)
        XCTAssertNil(HomeTile.tiles(threads: ThreadSummary(unreadCount: 0, mentionCount: 0), drafts: 0, saved: 0, firedReminders: 0)
            .first { $0.kind == .reservations })
    }

    func testActivityItemOfKindReservation() throws {
        let json = """
        {"kind": "reservation", "at": "2026-10-05T01:00:00Z", "message": null, "canvas": null, "actor_ids": [], "emojis": [],
         "reservation": {"item_id": "n1", "pool_id": "p1", "pool_name": "シート", "reservation_id": "q1",
                         "text": "🙋 わたし さんに割り当ててください", "operator": true, "done": false, "done_at": null, "done_by": null}}
        """
        let item = try JSON.snakeDecoder.decode(ActivityItem.self, from: Data(json.utf8))
        XCTAssertEqual(item.id, "reservation:n1")
        XCTAssertEqual(ActivityRules.headline(item, nameOf: { $0 }).who, "シート")
        XCTAssertEqual(ActivityRules.excerpt(item, users: [:]), "🙋 わたし さんに割り当ててください")
        XCTAssertEqual(ActivityRules.append([], [item]).count, 1)
        // another operator handled it: activity.updated marks it done
        XCTAssertEqual(ActivityRules.blankingExcerpts([item], itemIds: ["n1"]).first?.reservation?.done, true)
    }

    func testStorePutsAndDropsPools() {
        let store = Store()
        XCTAssertNil(store.reservationPools)
        let first = PoolOut(id: "p1", name: "シート", capacity: 1)
        store.setReservationPools([first])
        var renamed = first
        renamed.bookings = [booking("b", user: "u", from: 12, to: 13)]
        store.putReservationPool(renamed)
        XCTAssertEqual(store.reservationPools?.first?.bookings.count, 1)
        store.dropReservationPool("p1")
        XCTAssertEqual(store.reservationPools, [])
    }

    func testPoolsLoadAfterBootstrapAndFollowReservationUpdatedAndNotices() async throws {
        let server = FakeServer()
        let alice = server.addUser("alice")
        let bob = server.addUser("bob")
        _ = server.createChannel("general", ownerId: alice.id)
        server.pools = [PoolOut(id: "p1", name: "シート", capacity: 1)]
        let store = Store()
        var options = EngineOptions()
        options.sleep = { _ in }
        let engine = SyncEngine(api: server.api(for: bob.id), connect: server.connector(for: bob.id), wsUrl: URL(string: "ws://fake")!, store: store,
                                getAccessToken: { "t" }, options: options)
        var notices: [String] = []
        engine.onReservationNotice = { notices.append($0.text) }
        await engine.start()
        await engine.idle()
        for _ in 0..<20 { await Task.yield() }
        XCTAssertEqual(store.reservationPools?.map(\.name), ["シート"])
        let reads = server.poolReads
        server.setPools([PoolOut(id: "p1", name: "Claude Premium シート", capacity: 1)])
        server.setPools([PoolOut(id: "p1", name: "Claude Premium シート", capacity: 1)])
        await engine.idle()
        try await Task.sleep(for: .milliseconds(400))
        XCTAssertEqual(store.reservationPools?.map(\.name), ["Claude Premium シート"])
        XCTAssertEqual(server.poolReads, reads + 1)
        server.noticeReservation(bob.id, text: "🙋 割り当ててください")
        await engine.idle()
        XCTAssertEqual(notices, ["🙋 割り当ててください"])
        engine.stop()
    }

    /// Review v0.1.37 #6: an answer that started before one already kept never overwrites it (two reads overlapping).
    func testAnOlderPoolsAnswerDoesNotOverwriteANewerOne() async throws {
        let server = FakeServer()
        let bob = server.addUser("bob")
        server.pools = [PoolOut(id: "p1", name: "v0", capacity: 1)]
        let store = Store()
        var options = EngineOptions()
        options.sleep = { _ in }
        let engine = SyncEngine(api: server.api(for: bob.id), connect: server.connector(for: bob.id), wsUrl: URL(string: "ws://fake")!, store: store,
                                getAccessToken: { "t" }, options: options)
        let (released, release) = AsyncStream<Void>.makeStream()
        var asked = false
        server.poolsHold = { asked = true; for await _ in released { break } }
        server.pools = [PoolOut(id: "p1", name: "old", capacity: 1)]
        let first = Task { await engine.loadReservationPools() } // held: answers "old"
        for _ in 0..<50 where !asked { await Task.yield() }
        XCTAssertTrue(asked)
        server.pools = [PoolOut(id: "p1", name: "new", capacity: 1)]
        await engine.loadReservationPools()
        XCTAssertEqual(store.reservationPools?.map(\.name), ["new"])
        release.yield()
        await first.value
        XCTAssertEqual(store.reservationPools?.map(\.name), ["new"])
        engine.stop()
    }
}
