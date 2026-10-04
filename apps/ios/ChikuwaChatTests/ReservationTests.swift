import XCTest
@testable import ChikuwaChat

/// M99 (docs/RESERVATIONS.md §6): a channel's reservation pools — decoding, the card's words, and live reloads.
@MainActor
final class ReservationTests: XCTestCase {
    private func row(_ id: String, user: String, status: String = "waiting", position: Int? = nil, step: String? = nil,
                     pair: String? = nil, guarantee: String? = nil, evict: String? = nil, ready: Bool = false) -> ReservationOut {
        ReservationOut(id: id, userId: user, status: status, requestedAt: "2026-10-04T00:00:00Z",
                       assignedAt: status == "waiting" ? nil : "2026-10-04T00:00:00Z", guaranteeUntil: guarantee, returnedAt: nil,
                       evictAt: evict, email: nil, position: position, step: step, pairId: pair, ready: ready)
    }

    private func pool(holders: [ReservationOut], waiting: [ReservationOut], mine: String? = nil, next: String? = nil) -> PoolOut {
        PoolOut(id: "p1", channelId: "c1", name: "Claude Premium シート", capacity: 1, minHours: 6, graceMinutes: 15, tz: "Asia/Tokyo",
                enabled: true, operatorIds: [], botUserId: nil, holders: holders, waiting: waiting, nextEvictId: next,
                myReservationId: mine, canManage: false, canOperate: false, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z")
    }

    func testDecodesTheServersPool() throws {
        let json = """
        {"id": "p1", "channel_id": "c1", "name": "シート", "capacity": 3, "min_hours": 6, "grace_minutes": 15, "tz": "Asia/Tokyo",
         "enabled": true, "operator_ids": ["u9"], "bot_user_id": "b1",
         "holders": [{"id": "r1", "user_id": "u1", "status": "holding", "requested_at": "2026-10-04T00:00:00Z",
                      "assigned_at": "2026-10-04T00:10:00Z", "guarantee_until": "2026-10-04T06:10:00Z", "returned_at": null,
                      "evict_at": null, "email": "a@example.jp", "position": null, "step": null, "pair_id": "r2", "ready": false}],
         "waiting": [{"id": "r2", "user_id": "u2", "status": "waiting", "requested_at": "2026-10-04T01:00:00Z", "assigned_at": null,
                      "guarantee_until": null, "returned_at": null, "evict_at": null, "email": null, "position": 1, "step": "swap",
                      "pair_id": "r1", "ready": false}],
         "next_evict_id": "r1", "my_reservation_id": "r2", "can_manage": false, "can_operate": true,
         "created_at": "2026-10-01T00:00:00Z", "updated_at": "2026-10-01T00:00:00Z"}
        """
        let pool = try JSON.snakeDecoder.decode(PoolOut.self, from: Data(json.utf8))
        XCTAssertEqual(pool.holders.first?.email, "a@example.jp")
        XCTAssertEqual(pool.waiting.first?.step, "swap")
        XCTAssertEqual(pool.nextEvictId, "r1")
        XCTAssertTrue(pool.canOperate)
        XCTAssertEqual(ReservationRules.summary(pool), "1/3 · 待ち 1")
        XCTAssertEqual(ReservationRules.myStatus(pool), "待ち 1 番目")
    }

    func testWordsForMembersAndHolders() {
        let when: (String) -> String = { $0 == "2026-10-04T06:00:00Z" ? "15:00" : "15:15" }
        let holder = row("h1", user: "alice", status: "holding", pair: "w1", guarantee: "2026-10-04T06:00:00Z")
        let waiter = row("w1", user: "bob", position: 1, step: "swap", pair: "h1")
        let p = pool(holders: [holder], waiting: [waiter], mine: "h1", next: "h1")
        XCTAssertEqual(ReservationRules.myStatus(p, when: when), "利用中 (保証 15:00 まで)")
        XCTAssertFalse(ReservationRules.urgent(p))
        let told = pool(holders: [row("h1", user: "alice", status: "holding", pair: "w1", guarantee: "2026-10-04T06:00:00Z",
                                      evict: "2026-10-04T06:15:00Z")], waiting: [waiter], mine: "h1")
        XCTAssertEqual(ReservationRules.myStatus(told, when: when), "15:15 以降に外されます")
        XCTAssertTrue(ReservationRules.urgent(told))
        let name: (String) -> String = { $0 == "alice" ? "アリス" : "ボブ" }
        XCTAssertEqual(ReservationRules.waiterLine(waiter, pool: p, name: name, when: { _ in "9:00" }), "9:00 に予約 · アリス さんの後")
        XCTAssertEqual(ReservationRules.holderBadge(holder, pool: p, now: Date(timeIntervalSince1970: 0))?.text, "次に外す")
        let ready = row("h1", user: "alice", status: "holding", guarantee: "2026-10-04T06:00:00Z", evict: "2026-10-04T06:15:00Z", ready: true)
        XCTAssertEqual(ReservationRules.holderBadge(ready, pool: p)?.text, "入れ替えできます")
        XCTAssertEqual(ReservationRules.holderBadge(row("r", user: "x", status: "returning"), pool: p)?.text, "返却済み · 外し待ち")
        XCTAssertTrue(ReservationRules.early(holder, now: Date(timeIntervalSince1970: 0)))
        XCTAssertFalse(ReservationRules.early(holder, now: Date(timeIntervalSince1970: 2_000_000_000)))
    }

    func testStorePutsAndDropsPools() {
        let store = Store()
        let first = pool(holders: [], waiting: [])
        store.setReservationPools("c1", [first])
        var renamed = first
        renamed.holders = [row("h", user: "u", status: "holding")]
        store.putReservationPool(renamed)
        XCTAssertEqual(store.poolsOf("c1").first?.holders.count, 1)
        store.dropReservationPool("c1", "p1")
        XCTAssertEqual(store.poolsOf("c1"), [])
    }

    func testPoolsLoadWhenTheConversationOpensAndFollowReservationUpdated() async {
        let server = FakeServer()
        let alice = server.addUser("alice")
        let bob = server.addUser("bob")
        let channel = server.createChannel("claude", ownerId: alice.id)
        server.join(channel.id, bob.id)
        server.pools[channel.id] = [pool(holders: [], waiting: [])]
        let store = Store()
        var options = EngineOptions()
        options.sleep = { _ in }
        let engine = SyncEngine(api: server.api(for: bob.id), connect: server.connector(for: bob.id), wsUrl: URL(string: "ws://fake")!, store: store,
                                getAccessToken: { "t" }, options: options)
        await engine.start()
        await engine.idle()
        XCTAssertEqual(store.poolsOf(channel.id), []) // not part of bootstrap
        await engine.openChannel(channel.id)
        for _ in 0..<20 { await Task.yield() }
        XCTAssertEqual(store.poolsOf(channel.id).first?.waiting.count, 0)
        server.setPools(channel.id, [pool(holders: [], waiting: [row("w1", user: alice.id, position: 1, step: "assign")])])
        await engine.idle()
        for _ in 0..<20 { await Task.yield() }
        XCTAssertEqual(store.poolsOf(channel.id).first?.waiting.map(\.id), ["w1"])
        engine.stop()
    }
}
