import XCTest
@testable import ChikuwaChat

/// SYNC_PROTOCOL.md §10.1 / §10.2 (M17): visible-range reads never skip unread rows this device has not loaded.
/// Alice posts, bob reads; pages of 50 unless a vector says otherwise.
@MainActor
final class UnreadRangeTests: XCTestCase {
    struct World {
        let server: FakeServer
        let alice: UserPublic
        let bob: UserPublic
        let channel: ChannelOut
        let store: Store
        let engine: SyncEngine
        let api: FakeServer.Api
    }

    /// `sleep` replaces the engine's timers (read debounces included); the default fires them at once.
    private func makeWorld(pageSize: Int = 50, gapLimit: Int = 5000, sleep: ((TimeInterval) async -> Void)? = nil) -> World {
        let server = FakeServer()
        let alice = server.addUser("alice")
        let bob = server.addUser("bob")
        let channel = server.createChannel("general", ownerId: alice.id)
        server.join(channel.id, bob.id)
        let store = Store()
        var options = EngineOptions()
        options.pageSize = pageSize
        options.gapLimit = gapLimit
        options.reconnectMin = 0
        options.sleep = sleep ?? { _ in }
        options.random = { 0.5 }
        let api = server.api(for: bob.id)
        let engine = SyncEngine(api: api, connect: server.connector(for: bob.id), wsUrl: URL(string: "ws://fake")!, store: store,
                                getAccessToken: { "token" }, options: options)
        return World(server: server, alice: alice, bob: bob, channel: channel, store: store, engine: engine, api: api)
    }

    private func settle(_ engine: SyncEngine) async {
        for _ in 0..<50 {
            await engine.idle()
            await Task.yield()
        }
    }

    /// Drops bob's connection, runs `whileAway`, and waits for the reconnect to finish its catch-up.
    private func reconnect(_ w: World, whileAway: () -> Void) async {
        let before = w.engine.reconnects
        w.server.disconnect(w.bob.id)
        whileAway()
        for _ in 0..<100 where w.engine.reconnects == before || w.engine.status != .online { await settle(w.engine) }
        await w.engine.flushReads()
        await settle(w.engine)
    }

    /// Bob's position is `lastRead`; this device opens the channel for the first time (no synced timeline).
    @discardableResult
    private func open(_ w: World, total: Int, lastRead: Int) async -> [MessageOut] {
        let rows = w.server.seed(w.channel.id, senderId: w.alice.id, count: total)
        w.server.readPositions["\(w.bob.id):\(w.channel.id)"] = lastRead
        await w.engine.openChannel(w.channel.id)
        await w.engine.start()
        await settle(w.engine)
        return rows
    }

    private func state(_ w: World) -> ChannelState { w.store.channel(w.channel.id)! }
    private func serverRead(_ w: World) -> ReadStateOut { w.server.readState(userId: w.bob.id, channelId: w.channel.id) }
    private func read(_ w: World, _ seq: Int, force: Bool = false) async {
        w.engine.markRead(w.channel.id, seq: seq, force: force)
        await w.engine.flushReads()
        await settle(w.engine)
    }
    private func putCount(_ w: World) -> Int { w.api.calls.filter { $0 == "markRead" }.count }

    /// One look of the channel view (ChannelView.markRead): the store's rows and channel state as they are now, `shown`
    /// the rows on screen. Returns the seq the view would mark read.
    private func look(_ anchor: inout ReadAnchor, _ w: World, shown: ClosedRange<Int>) -> Int? {
        let rows = w.store.messages(w.channel.id)
        let channel = state(w)
        let visible = rows.filter { shown.contains($0.seq ?? 0) }
        return anchor.observe(unreadCount: channel.unreadCount, ready: ReadGate.readRangeReady(channel),
                              firstUnread: ReadGate.firstUnreadRow(rows, afterSeq: channel.lastReadSeq, meId: w.bob.id),
                              visible: visible, onScreenIds: Set(visible.map(\.id)))
    }

    func testV1UnreadWithinThePageIsReady() async {
        let w = makeWorld()
        await open(w, total: 130, lastRead: 100)
        XCTAssertEqual(w.api.historyRequests, ["before_seq=nil&limit=50"])
        XCTAssertEqual(state(w).oldestLoadedSeq, 81)
        XCTAssertEqual(state(w).unreadCount, 30)
        XCTAssertTrue(w.engine.readRangeReady(w.channel.id))
        await read(w, 115)
        XCTAssertEqual(serverRead(w).lastReadSeq, 115)
        XCTAssertEqual(state(w).lastReadSeq, 115)
        w.engine.stop()
    }

    /// The M17 acceptance check: opening 2,000 unread never sends PUT /read past the loaded start.
    func testV2UnreadBeyondThePageIsNotMarkedByVisibleRows() async throws {
        let w = makeWorld()
        let rows = await open(w, total: 3000, lastRead: 1000)
        XCTAssertEqual(w.api.historyRequests, ["before_seq=nil&limit=50"])
        XCTAssertEqual(state(w).oldestLoadedSeq, 2951)
        XCTAssertEqual(state(w).unreadCount, 2000)
        XCTAssertEqual(state(w).firstUnreadAt, rows[1000].createdAt) // seq 1001, from bootstrap
        XCTAssertFalse(w.engine.readRangeReady(w.channel.id))
        await read(w, 3000)
        XCTAssertEqual(state(w).lastReadSeq, 1000)
        XCTAssertEqual(putCount(w), 0)
        XCTAssertEqual(serverRead(w).lastReadSeq, 1000)
        let banner = try XCTUnwrap(ReadGate.banner(state(w), focused: false, positioned: true, anchored: false, held: false, jumping: false, status: .online))
        XCTAssertNotNil(banner.text.range(of: #"^未読 2,000 件 · \d\d:\d\d 以降$"#, options: .regularExpression), banner.text)
        XCTAssertFalse(banner.jump)
        w.engine.stop()
    }

    func testV3ReadAllExplicitlyGoesToTheEnd() async {
        let w = makeWorld()
        await open(w, total: 3000, lastRead: 1000)
        await read(w, 3000, force: true)
        XCTAssertEqual(putCount(w), 1)
        XCTAssertEqual(serverRead(w).lastReadSeq, 3000)
        XCTAssertEqual(serverRead(w).unreadCount, 0)
        XCTAssertNil(serverRead(w).firstUnreadAt)
        XCTAssertEqual(state(w).lastReadSeq, 3000)
        XCTAssertEqual(state(w).unreadCount, 0)
        XCTAssertNil(state(w).firstUnreadAt)
        XCTAssertNil(ReadGate.banner(state(w), focused: false, positioned: true, anchored: false, held: false, jumping: false, status: .online))
        w.engine.stop()
    }

    func testV4JumpPagesBackToTheReadPosition() async throws {
        let w = makeWorld()
        await open(w, total: 1300, lastRead: 1000)
        XCTAssertFalse(w.engine.readRangeReady(w.channel.id))
        XCTAssertEqual(ReadGate.banner(state(w), focused: false, positioned: true, anchored: false, held: false, jumping: false, status: .online)?.jump, true)
        let covered = try await w.engine.loadFirstUnread(w.channel.id)
        XCTAssertTrue(covered)
        XCTAssertEqual(w.api.historyRequests, ["before_seq=nil&limit=50", "before_seq=1251&limit=200", "before_seq=1051&limit=200"])
        XCTAssertEqual(state(w).oldestLoadedSeq, 851)
        XCTAssertEqual(w.store.messages(w.channel.id).count, 450)
        XCTAssertTrue(w.engine.readRangeReady(w.channel.id))
        // The view: divider before 1001 at the top, then reading downwards marks as usual.
        let rows = w.store.messages(w.channel.id)
        let mark = ReadGate.dividerMark(held: nil, captured: state(w).lastReadSeq, oldestLoadedSeq: state(w).oldestLoadedSeq)
        XCTAssertEqual(mark, 1000)
        XCTAssertEqual(ReadGate.openTarget(rows, focusId: nil, mark: mark, meId: w.bob.id), .top(try XCTUnwrap(rows.first { $0.seq == 1001 }).rowKey))
        await read(w, 1012)
        XCTAssertEqual(serverRead(w).lastReadSeq, 1012)
        w.engine.stop()
    }

    func testV5SkippedSeqsMakeCoversConservative() async throws {
        let w = makeWorld()
        let first = w.server.seed(w.channel.id, senderId: w.alice.id, count: 100)
        for i in 1...3 { try w.server.post(channelId: w.channel.id, senderId: w.alice.id, body: "reply \(i)", parentId: first[49].id) } // seq 101...103
        await open(w, total: 50, lastRead: 100) // top-level 104...153
        XCTAssertEqual(state(w).oldestLoadedSeq, 104)
        XCTAssertEqual(state(w).unreadCount, 50)
        XCTAssertFalse(w.engine.readRangeReady(w.channel.id))
        await read(w, 153)
        XCTAssertEqual(putCount(w), 0)
        let banner = try XCTUnwrap(ReadGate.banner(state(w), focused: false, positioned: true, anchored: false, held: false, jumping: false, status: .online))
        XCTAssertTrue(banner.text.hasPrefix("未読 50 件 · "))
        XCTAssertTrue(banner.jump)
        let covered = try await w.engine.loadFirstUnread(w.channel.id)
        XCTAssertTrue(covered)
        XCTAssertEqual(w.api.historyRequests.dropFirst(), ["before_seq=104&limit=200"])
        let rows = w.store.messages(w.channel.id)
        let items = Timeline.build(rows, firstUnreadAfterSeq: ReadGate.dividerMark(held: nil, captured: 100, oldestLoadedSeq: state(w).oldestLoadedSeq), meId: w.bob.id, grouping: true)
        let divider = try XCTUnwrap(items.firstIndex { if case .unread = $0 { return true } else { return false } })
        guard case .message(let after, _) = items[divider + 1] else { return XCTFail("no row after the divider") }
        XCTAssertEqual(after.seq, 104)
        w.engine.stop()
    }

    func testV6ScrollingUpReachesTheRangeButMarksOnlyOnceTheFirstUnreadRowIsShown() async throws {
        let w = makeWorld()
        await open(w, total: 1300, lastRead: 1000)
        for _ in 0..<5 { await w.engine.loadOlder(w.channel.id) }
        XCTAssertEqual(state(w).oldestLoadedSeq, 1001)
        XCTAssertTrue(w.engine.readRangeReady(w.channel.id))
        XCTAssertEqual(ReadGate.dividerMark(held: nil, captured: 1000, oldestLoadedSeq: 1001), 1000)
        let rows = w.store.messages(w.channel.id)
        let first = ReadGate.firstUnreadRow(rows, afterSeq: state(w).lastReadSeq, meId: w.bob.id)
        XCTAssertEqual(first?.seq, 1001)
        let viewport = Set(rows.filter { (1045...1060).contains($0.seq ?? 0) }.map(\.id))
        XCTAssertFalse(ReadGate.nextAnchored(false, unreadCount: state(w).unreadCount, ready: true, firstUnread: first, visibleMessageIds: viewport))
        XCTAssertTrue(ReadGate.nextAnchored(false, unreadCount: state(w).unreadCount, ready: true, firstUnread: first, visibleMessageIds: [first!.id]))
        // The banner keeps 「最初の未読へ」, which now only scrolls: no request.
        let before = w.api.historyRequests.count
        let covered = try await w.engine.loadFirstUnread(w.channel.id)
        XCTAssertTrue(covered)
        XCTAssertEqual(w.api.historyRequests.count, before)
        w.engine.stop()
    }

    func testV7ReadElsewhereMakesTheRangeReady() async throws {
        let w = makeWorld()
        await open(w, total: 3000, lastRead: 1000)
        try w.server.markRead(userId: w.bob.id, channelId: w.channel.id, seq: 2990) // another device
        await settle(w.engine)
        XCTAssertEqual(state(w).lastReadSeq, 2990)
        XCTAssertEqual(state(w).unreadCount, 10)
        XCTAssertEqual(state(w).firstUnreadAt, w.server.channels[w.channel.id]?.messages[2990].createdAt)
        XCTAssertTrue(w.engine.readRangeReady(w.channel.id))
        let banner = try XCTUnwrap(ReadGate.banner(state(w), focused: false, positioned: true, anchored: false, held: false, jumping: false, status: .online))
        XCTAssertTrue(banner.text.hasPrefix("未読 10 件 · "))
        XCTAssertTrue(banner.jump)
        let before = w.api.historyRequests.count
        let covered = try await w.engine.loadFirstUnread(w.channel.id)
        XCTAssertTrue(covered)
        XCTAssertEqual(w.api.historyRequests.count, before) // no request: the press only scrolls
        await read(w, 3000)
        XCTAssertEqual(serverRead(w).lastReadSeq, 3000)
        w.engine.stop()
    }

    func testV8V9LiveMessagesWhileTheRangeIsNotHeld() async throws {
        let w = makeWorld()
        await open(w, total: 3000, lastRead: 1000)
        let since = state(w).firstUnreadAt
        try w.server.post(channelId: w.channel.id, senderId: w.alice.id, body: "3001")
        await settle(w.engine)
        XCTAssertEqual(state(w).unreadCount, 2001)
        await read(w, 3001)
        XCTAssertEqual(putCount(w), 0)
        XCTAssertEqual(state(w).firstUnreadAt, since)
        XCTAssertTrue(try XCTUnwrap(ReadGate.banner(state(w), focused: false, positioned: true, anchored: false, held: false, jumping: false, status: .online))
            .text.hasPrefix("未読 2,001 件 · "))

        await w.engine.send(w.channel.id, body: "mine") // V9: my own top-level post reads the channel
        await settle(w.engine)
        XCTAssertEqual(state(w).lastReadSeq, 3002)
        XCTAssertEqual(state(w).unreadCount, 0)
        XCTAssertNil(state(w).firstUnreadAt)
        XCTAssertNil(ReadGate.banner(state(w), focused: false, positioned: true, anchored: false, held: false, jumping: false, status: .online))
        w.engine.stop()
    }

    func testV10GapReloadDropsTheRange() async {
        let w = makeWorld()
        await open(w, total: 130, lastRead: 100)
        await read(w, 130)
        XCTAssertEqual(state(w).unreadCount, 0)
        await reconnect(w) { w.server.seed(w.channel.id, senderId: w.alice.id, count: 6000) }
        XCTAssertEqual(w.engine.reloads, 1)
        XCTAssertEqual(state(w).oldestLoadedSeq, 6081)
        XCTAssertEqual(state(w).unreadCount, 6000)
        XCTAssertFalse(w.engine.readRangeReady(w.channel.id))
        XCTAssertFalse(ReadGate.nextAnchored(true, unreadCount: 6000, ready: false, firstUnread: nil, visibleMessageIds: []))
        await read(w, 6130)
        XCTAssertEqual(serverRead(w).lastReadSeq, 130)
        let banner = ReadGate.banner(state(w), focused: false, positioned: true, anchored: false, held: false, jumping: false, status: .online)
        XCTAssertEqual(banner?.jump, false)
        XCTAssertEqual(banner?.text.hasPrefix("未読 6,000 件"), true)
        w.engine.stop()
    }

    func testV11SetFromAnotherDeviceWithinTheWindowStaysReady() async throws {
        let w = makeWorld()
        await open(w, total: 130, lastRead: 100)
        w.server.seed(w.channel.id, senderId: w.alice.id, count: 1000)
        w.engine.reconnectNow() // caught up by the delta: the window grows to 81...1130
        await settle(w.engine)
        XCTAssertEqual(state(w).syncedSeq, 1130)
        XCTAssertEqual(state(w).oldestLoadedSeq, 81)
        try w.server.markRead(userId: w.bob.id, channelId: w.channel.id, seq: 500, mode: "set")
        await settle(w.engine)
        XCTAssertEqual(state(w).lastReadSeq, 500)
        XCTAssertEqual(state(w).unreadCount, 630)
        XCTAssertTrue(w.engine.readRangeReady(w.channel.id))
        let rows = w.store.messages(w.channel.id)
        let first = ReadGate.firstUnreadRow(rows, afterSeq: 500, meId: w.bob.id)
        XCTAssertEqual(first?.seq, 501)
        XCTAssertTrue(ReadGate.nextAnchored(true, unreadCount: 630, ready: true, firstUnread: first, visibleMessageIds: []))
        XCTAssertEqual(ReadGate.dividerMark(held: nil, captured: 100, oldestLoadedSeq: state(w).oldestLoadedSeq), 100) // unchanged
        // The view (V11's rule): the position went down, so the anchor holds only once row 501 has been on screen again;
        // the rows already shown (1101...1130) do not undo the other device's mark.
        var anchor = ReadAnchor()
        let shown = rows.filter { (1101...1130).contains($0.seq ?? 0) }
        XCTAssertEqual(anchor.observe(unreadCount: 30, ready: true, firstUnread: ReadGate.firstUnreadRow(rows, afterSeq: 1100, meId: w.bob.id),
                                      visible: shown, onScreenIds: Set(shown.map(\.id))), 1130)
        anchor.positionLowered()
        XCTAssertNil(anchor.observe(unreadCount: 630, ready: true, firstUnread: first, visible: shown, onScreenIds: Set(shown.map(\.id))))
        let top = rows.filter { (501...512).contains($0.seq ?? 0) }
        XCTAssertEqual(anchor.observe(unreadCount: 630, ready: true, firstUnread: first, visible: top, onScreenIds: Set(top.map(\.id))), 512)
        w.engine.stop()
    }

    /// Review: bootstrap raised last_seq while this device's window ended at the read position (the app was away with
    /// another view open, so only bootstrap ran). covers() holds, but none of the 300 unread rows is here: visible marks
    /// wait for the catch-up, which the open then runs.
    func testStaleNewestSideWaitsForTheCatchUp() async {
        let w = makeWorld()
        await open(w, total: 130, lastRead: 100)
        await read(w, 130)
        XCTAssertEqual(serverRead(w).lastReadSeq, 130)
        w.engine.currentChannelId = nil // the threads list, say: no conversation is caught up on reconnect
        await reconnect(w) { w.server.seed(w.channel.id, senderId: w.alice.id, count: 300) }
        XCTAssertEqual(state(w).lastSeq, 430)
        XCTAssertEqual(state(w).syncedSeq, 130)
        XCTAssertEqual(state(w).unreadCount, 300)
        XCTAssertTrue(ReadGate.covers(state(w).oldestLoadedSeq, 130))
        XCTAssertFalse(w.engine.readRangeReady(w.channel.id))
        let puts = putCount(w)
        await read(w, 430) // rows 81...130 on screen, then the list follows the delta to the bottom
        XCTAssertEqual(putCount(w), puts)
        XCTAssertEqual(state(w).lastReadSeq, 130)
        XCTAssertEqual(serverRead(w).lastReadSeq, 130)
        await w.engine.openChannel(w.channel.id) // the delta brings 131...430
        await settle(w.engine)
        XCTAssertEqual(state(w).syncedSeq, 430)
        XCTAssertTrue(w.engine.readRangeReady(w.channel.id))
        await read(w, 140)
        XCTAssertEqual(serverRead(w).lastReadSeq, 140)
        w.engine.stop()
    }

    /// V33–V35 (§10.1 1., 2., 4., 5.): bob read to 130 and was anchored at the bottom; 300 arrived while the app was
    /// away. Reconnected, bootstrap says 430 / 300 unread and the delta has not run yet (another view was open; a store
    /// restored at launch and opened before its catch-up is the same state).
    func testV33ToV35ComingBackAfterBeingAway() async throws {
        let w = makeWorld()
        await open(w, total: 130, lastRead: 100)
        await read(w, 130)
        var anchor = ReadAnchor()
        XCTAssertEqual(look(&anchor, w, shown: 116...130), 130)
        w.engine.currentChannelId = nil
        await reconnect(w) { w.server.seed(w.channel.id, senderId: w.alice.id, count: 300) }
        XCTAssertEqual(state(w).syncedSeq, 130)
        XCTAssertEqual(state(w).unreadCount, 300)

        // V33: not ready, so not anchored, and visible marks do nothing; the banner waits for the rows.
        XCTAssertFalse(w.engine.readRangeReady(w.channel.id))
        XCTAssertNil(look(&anchor, w, shown: 116...130))
        XCTAssertFalse(anchor.anchored)
        let puts = putCount(w)
        await read(w, 430)
        XCTAssertEqual(putCount(w), puts)
        XCTAssertEqual(state(w).lastReadSeq, 130)
        let held = ReadGate.firstUnreadRow(w.store.messages(w.channel.id), afterSeq: 130, meId: w.bob.id) != nil
        XCTAssertFalse(held)
        XCTAssertNil(ReadGate.banner(state(w), focused: false, positioned: true, anchored: anchor.hidesBanner, held: false, jumping: false,
                                     status: w.engine.status, firstUnreadHeld: held))

        // V35: a view opening now waits for the delta, then lands at the divider with row 131 below it.
        XCTAssertTrue(ReadGate.placementWaits(state(w), status: w.engine.status, userScrolled: false, waitOver: false))
        await w.engine.openChannel(w.channel.id)
        await settle(w.engine)
        XCTAssertEqual(state(w).syncedSeq, 430)
        XCTAssertTrue(w.engine.readRangeReady(w.channel.id))
        XCTAssertFalse(ReadGate.placementWaits(state(w), status: w.engine.status, userScrolled: false, waitOver: false))
        let rows = w.store.messages(w.channel.id)
        let first = try XCTUnwrap(rows.first { $0.seq == 131 })
        let mark = ReadGate.dividerMark(held: nil, captured: ReadGate.openMark(state(w)), oldestLoadedSeq: state(w).oldestLoadedSeq)
        XCTAssertEqual(ReadGate.openTarget(rows, focusId: nil, mark: mark, meId: w.bob.id), .top(first.rowKey))

        // V34: the view that stayed open followed the bottom (416...430); row 131 went by unseen.
        XCTAssertNil(look(&anchor, w, shown: 416...430))
        XCTAssertFalse(anchor.anchored)
        let banner = try XCTUnwrap(ReadGate.banner(state(w), focused: false, positioned: true, anchored: anchor.hidesBanner, held: false, jumping: false,
                                                   status: w.engine.status, firstUnreadHeld: true))
        XCTAssertTrue(banner.text.hasPrefix("未読 300 件 · "))
        XCTAssertTrue(banner.jump)
        let requests = w.api.historyRequests.count
        let covered = try await w.engine.loadFirstUnread(w.channel.id)
        XCTAssertTrue(covered)
        XCTAssertEqual(w.api.historyRequests.count, requests) // every row is here: the press only scrolls
        anchor.land(on: first)
        XCTAssertNil(look(&anchor, w, shown: 416...430)) // frames from before the scroll
        anchor.landed()
        XCTAssertEqual(look(&anchor, w, shown: 131...142), 142)
        await read(w, 142)
        XCTAssertEqual(serverRead(w).lastReadSeq, 142)
        w.engine.stop()
    }

    /// V37: a 「ここから未読にする」 hold ends when another conversation opens, even one opened from the search sheet
    /// while this view stays on screen, and the position stays where it was set (ReadAnchorTests covers the view).
    func testV37AHoldEndsWhenAnotherConversationOpens() async {
        let w = makeWorld()
        let other = w.server.createChannel("random", ownerId: w.alice.id)
        w.server.join(other.id, w.bob.id)
        await open(w, total: 130, lastRead: 100)
        XCTAssertEqual(w.engine.markUnread(w.channel.id, seq: 110), 109)
        XCTAssertEqual(w.engine.unreadHold[w.channel.id], 109)
        await w.engine.openChannel(other.id)
        XCTAssertNil(w.engine.unreadHold[w.channel.id])
        await w.engine.flushReads()
        await settle(w.engine)
        XCTAssertEqual(state(w).lastReadSeq, 109)
        XCTAssertEqual(serverRead(w).lastReadSeq, 109)
        w.engine.stop()
    }

    /// §10: a hold lasts until its conversation is left, also when no other one opens (back to the channel list on
    /// iPhone, the threads / mentions / saved views). Opening the same channel again starts without it: a hold kept
    /// there hid the banner and ignored every visible-range read.
    func testAHoldEndsWhenTheConversationIsLeft() async {
        let w = makeWorld()
        await open(w, total: 130, lastRead: 100)
        XCTAssertEqual(w.engine.markUnread(w.channel.id, seq: 110), 109)
        await w.engine.flushReads()
        await settle(w.engine)
        w.engine.closeConversation()
        XCTAssertNil(w.engine.unreadHold[w.channel.id])
        XCTAssertNil(w.engine.currentChannelId)
        await w.engine.openChannel(w.channel.id)
        XCTAssertNil(w.engine.unreadHold[w.channel.id])
        XCTAssertEqual(state(w).lastReadSeq, 109)
        await read(w, 115)
        XCTAssertEqual(serverRead(w).lastReadSeq, 115)
        w.engine.stop()
    }

    /// §10.1 8./12.: 「ここから未読にする」 counts the rows after the new position as the server does, system rows left out,
    /// and 「… 以降」 starts at the first counted row.
    func testMarkUnreadCountsLikeTheServer() async throws {
        let w = makeWorld()
        await open(w, total: 130, lastRead: 130)
        try w.server.post(channelId: w.channel.id, senderId: w.alice.id, body: "alice joined", type: "system") // 131
        let (post, _) = try w.server.post(channelId: w.channel.id, senderId: w.alice.id, body: "hello") // 132
        await settle(w.engine)
        await read(w, 132)
        XCTAssertEqual(state(w).unreadCount, 0)
        XCTAssertEqual(w.engine.markUnread(w.channel.id, seq: 131), 130)
        XCTAssertEqual(state(w).unreadCount, 1) // before the server's answer
        XCTAssertEqual(state(w).firstUnreadAt, post.createdAt)
        await w.engine.flushReads()
        await settle(w.engine)
        XCTAssertEqual(serverRead(w).unreadCount, 1)
        XCTAssertEqual(state(w).unreadCount, 1)
        w.engine.stop()
    }

    /// V38 (§10.1 10.): moving the position forward with 「ここから未読にする」 needs every unread row held. Otherwise
    /// nothing moves and nothing is sent, and visible-range reads pause at the current position.
    func testV38MarkUnreadForwardWaitsForTheRange() async {
        let w = makeWorld()
        await open(w, total: 3000, lastRead: 1000)
        XCTAssertEqual(w.engine.markUnread(w.channel.id, seq: 2990), 1000)
        await w.engine.flushReads()
        await settle(w.engine)
        XCTAssertFalse(w.api.calls.contains("setReadPosition"))
        XCTAssertEqual(state(w).lastReadSeq, 1000)
        XCTAssertEqual(state(w).unreadCount, 2000)
        XCTAssertEqual(w.engine.unreadHold[w.channel.id], 1000)
        XCTAssertEqual(serverRead(w).lastReadSeq, 1000)
        XCTAssertNil(ReadGate.dividerMark(held: w.engine.unreadHold[w.channel.id], captured: 1000, oldestLoadedSeq: state(w).oldestLoadedSeq))
        // Backwards is always possible.
        XCTAssertEqual(w.engine.markUnread(w.channel.id, seq: 900), 899)
        await w.engine.flushReads()
        await settle(w.engine)
        XCTAssertEqual(serverRead(w).lastReadSeq, 899)
        XCTAssertEqual(state(w).lastReadSeq, 899)
        w.engine.stop()

        // V1 (read to 115, every unread row held): forward to row 125 sends {124, set}.
        let v1 = makeWorld()
        await open(v1, total: 130, lastRead: 100)
        await read(v1, 115)
        XCTAssertEqual(v1.engine.markUnread(v1.channel.id, seq: 125), 124)
        await v1.engine.flushReads()
        await settle(v1.engine)
        XCTAssertEqual(serverRead(v1).lastReadSeq, 124)
        XCTAssertEqual(state(v1).lastReadSeq, 124)
        v1.engine.stop()
    }

    /// V41 (§10.1 11.): my own message.created never moves the read position. A post from my other device is followed
    /// by the server's read.updated; a post from this device moves it from the POST response, at once, and ends a hold.
    func testV41MyOwnPostsMoveThePositionOnlyFromTheSendHere() async throws {
        let w = makeWorld()
        await open(w, total: 130, lastRead: 100)
        await read(w, 130)
        XCTAssertEqual(state(w).unreadCount, 0)
        try w.server.post(channelId: w.channel.id, senderId: w.alice.id, body: "131")
        await settle(w.engine)
        XCTAssertEqual([state(w).lastReadSeq, state(w).unreadCount], [130, 1])

        w.server.holdEvents = true
        try w.server.post(channelId: w.channel.id, senderId: w.bob.id, body: "132 from bob's laptop") // message.created, then read.updated
        w.server.holdEvents = false
        w.server.releaseNext()
        await settle(w.engine)
        XCTAssertEqual(state(w).lastSeq, 132)
        XCTAssertEqual([state(w).lastReadSeq, state(w).unreadCount], [130, 1])
        w.server.releaseNext()
        await settle(w.engine)
        XCTAssertEqual([state(w).lastReadSeq, state(w).unreadCount], [132, 0])

        try w.server.post(channelId: w.channel.id, senderId: w.alice.id, body: "133")
        await settle(w.engine)
        w.engine.markUnread(w.channel.id, seq: 133)
        await w.engine.flushReads()
        await settle(w.engine)
        XCTAssertEqual(w.engine.unreadHold[w.channel.id], 132)
        XCTAssertEqual([state(w).lastReadSeq, state(w).unreadCount], [132, 1])
        w.server.holdEvents = true // the events of the send below are still on their way
        await w.engine.send(w.channel.id, body: "134 from here")
        XCTAssertEqual([state(w).lastReadSeq, state(w).unreadCount], [134, 0])
        XCTAssertNil(state(w).firstUnreadAt)
        XCTAssertNil(w.engine.unreadHold[w.channel.id])
        w.server.holdEvents = false
        w.server.release()
        await settle(w.engine)
        XCTAssertEqual([state(w).lastReadSeq, state(w).unreadCount], [134, 0])
        XCTAssertEqual(serverRead(w).lastReadSeq, 134)
        w.engine.stop()
    }

    /// §10.1 11.: a poll made here (its own endpoint, not the outbox) reads like a send from here, from its response,
    /// and is the post the conversation goes to.
    func testAPollFromHereReadsLikeASend() async throws {
        let w = makeWorld()
        await open(w, total: 130, lastRead: 100)
        await read(w, 130)
        try w.server.post(channelId: w.channel.id, senderId: w.alice.id, body: "131")
        await settle(w.engine)
        XCTAssertEqual([state(w).lastReadSeq, state(w).unreadCount], [130, 1])
        w.server.holdEvents = true // its events are still on their way
        let (poll, _) = try w.server.post(channelId: w.channel.id, senderId: w.bob.id, body: "📊 lunch?")
        w.engine.postedFromHere(poll)
        XCTAssertEqual([state(w).lastReadSeq, state(w).unreadCount], [132, 0])
        XCTAssertEqual(w.engine.postedHere, poll.id)
        XCTAssertEqual(w.store.messages(w.channel.id).last?.id, poll.id)
        w.server.holdEvents = false
        w.server.release()
        await settle(w.engine)
        XCTAssertEqual([state(w).lastReadSeq, state(w).unreadCount], [132, 0])
        w.engine.stop()
    }

    /// §10.1 11.: a retry that finds my post already stored (the first response was lost) reads nothing now. The position
    /// came with that commit's read.updated, and the rows others posted since stay unread: zeroing them on the retry's
    /// response made the view anchor at once and mark the bottom row, skipping 132...185 unseen on every device.
    func testARetriedSendLeavesWhatOthersPostedSinceUnread() async throws {
        let w = makeWorld()
        await open(w, total: 130, lastRead: 130)
        var anchor = ReadAnchor()
        XCTAssertEqual(look(&anchor, w, shown: 116...130), 130)
        w.api.afterPost = { throw ApiError.network(URLError(.networkConnectionLost)) } // stored, but the response is lost
        await w.engine.send(w.channel.id, body: "131 from here", clientMsgId: "c-131")
        await settle(w.engine)
        XCTAssertEqual(serverRead(w).lastReadSeq, 131)
        XCTAssertEqual([state(w).lastReadSeq, state(w).unreadCount], [131, 0]) // the commit's read.updated
        XCTAssertEqual(w.store.outbox.map(\.clientMsgId), ["c-131"])
        w.api.afterPost = nil
        for i in 132...200 { try w.server.post(channelId: w.channel.id, senderId: w.alice.id, body: "\(i)") }
        await settle(w.engine)
        let since = state(w).firstUnreadAt
        XCTAssertEqual(state(w).unreadCount, 69)
        await w.engine.flushOutbox() // the retry gets 131 back, created false
        await settle(w.engine)
        XCTAssertTrue(w.store.outbox.isEmpty)
        XCTAssertEqual([state(w).lastReadSeq, state(w).unreadCount], [131, 69])
        XCTAssertEqual(state(w).firstUnreadAt, since)
        XCTAssertNil(look(&anchor, w, shown: 186...200)) // the list followed the bottom: 132 went by unseen
        XCTAssertFalse(anchor.anchored)
        await w.engine.flushReads()
        XCTAssertEqual(serverRead(w).lastReadSeq, 131)
        w.engine.stop()
    }

    /// §10.1 11.: the retry's response still ends a 「ここから未読にする」 hold, as any post of mine from here does, but it
    /// does not take the position back up over a mark-as-unread made after the first commit.
    func testARetriedSendEndsTheHoldButKeepsAMarkAsUnread() async throws {
        let w = makeWorld()
        await open(w, total: 130, lastRead: 130)
        w.api.afterPost = { throw ApiError.network(URLError(.networkConnectionLost)) }
        await w.engine.send(w.channel.id, body: "131 from here", clientMsgId: "c-131")
        await settle(w.engine)
        w.api.afterPost = nil
        XCTAssertEqual(serverRead(w).lastReadSeq, 131)
        XCTAssertEqual(w.engine.markUnread(w.channel.id, seq: 121), 120)
        await w.engine.flushReads()
        await settle(w.engine)
        XCTAssertEqual(serverRead(w).lastReadSeq, 120)
        await w.engine.flushOutbox() // created false
        await settle(w.engine)
        XCTAssertTrue(w.store.outbox.isEmpty)
        XCTAssertNil(w.engine.unreadHold[w.channel.id])
        XCTAssertEqual([state(w).lastReadSeq, state(w).unreadCount], [120, 10])
        XCTAssertEqual(serverRead(w).lastReadSeq, 120)
        w.engine.stop()
    }

    /// §10.1 11.: someone else's post that lands right after mine, with its event before my POST response, stays unread:
    /// the response moves the position to my post only, and the rows after it are counted again from those held.
    func testALateSendResponseKeepsWhatOthersPostedAfterIt() async throws {
        let w = makeWorld()
        await open(w, total: 130, lastRead: 130)
        var after: MessageOut?
        w.api.afterPost = {
            after = try w.server.post(channelId: w.channel.id, senderId: w.alice.id, body: "132, right after").0
            await self.settle(w.engine) // 131 (mine), its read.updated and 132 are applied before the response
            XCTAssertEqual(self.state(w).unreadCount, 1)
        }
        await w.engine.send(w.channel.id, body: "131 from here")
        w.api.afterPost = nil
        XCTAssertEqual([state(w).lastReadSeq, state(w).unreadCount], [131, 1])
        XCTAssertEqual(state(w).firstUnreadAt, after?.createdAt)
        await settle(w.engine)
        XCTAssertEqual([state(w).lastReadSeq, state(w).unreadCount], [131, 1])
        XCTAssertEqual(serverRead(w).unreadCount, 1)
        w.engine.stop()
    }

    /// V42 (§10.1 11.): a scheduled send of mine (M12d) does not read on the server, and its event reads nothing here.
    /// Moving the position on the event would let the next row on screen skip the 2,000 unread rows not held.
    func testV42MyScheduledSendReadsNothing() async throws {
        let w = makeWorld()
        await open(w, total: 3000, lastRead: 1000)
        let since = state(w).firstUnreadAt
        try w.server.post(channelId: w.channel.id, senderId: w.bob.id, body: "scheduled", advanceRead: false) // 3001
        await settle(w.engine)
        XCTAssertEqual([state(w).lastSeq, state(w).lastReadSeq, state(w).unreadCount], [3001, 1000, 2000])
        XCTAssertEqual(serverRead(w).lastReadSeq, 1000)
        try w.server.post(channelId: w.channel.id, senderId: w.alice.id, body: "3002")
        await settle(w.engine)
        XCTAssertEqual(state(w).unreadCount, 2001)
        XCTAssertEqual(state(w).firstUnreadAt, since)
        XCTAssertFalse(w.engine.readRangeReady(w.channel.id))
        await read(w, 3002) // on screen at the bottom
        XCTAssertEqual(putCount(w), 0)
        XCTAssertEqual(serverRead(w).lastReadSeq, 1000)
        w.engine.stop()
    }

    /// V43 (§10.1 11.): a reply I also send to the channel shows in the timeline, but neither moves the channel's read
    /// position (here or on the server) nor takes the timeline to the bottom; a top-level post of mine does both.
    func testV43AReplyAlsoSentToTheChannelLeavesThePosition() async throws {
        let w = makeWorld(pageSize: 400)
        let rows = await open(w, total: 400, lastRead: 130)
        var follows: [Bool] = [] // what the timeline would do while each send is pending
        w.api.beforePost = { follows.append(ReadGate.ownPendingPost(w.store.messages(w.channel.id).last, meId: w.bob.id)) }
        await w.engine.send(w.channel.id, body: "shared reply", parentId: rows[129].id, options: SendOptions(alsoInChannel: true))
        await settle(w.engine)
        XCTAssertEqual(w.store.messages(w.channel.id).last?.body, "shared reply")
        XCTAssertEqual([state(w).lastReadSeq, state(w).unreadCount], [130, 270])
        XCTAssertEqual(serverRead(w).lastReadSeq, 130)
        await w.engine.send(w.channel.id, body: "top-level")
        XCTAssertEqual(follows, [false, true])
        XCTAssertEqual([state(w).lastReadSeq, state(w).unreadCount], [402, 0])
        w.engine.stop()
    }

    /// V44 (§10.1 12.): a live system row is not counted, as the server does not count it; a user post is. The first
    /// unread row itself has no type filter: the system row is where the divider goes.
    func testV44LiveSystemRowsAreNotCounted() async throws {
        let w = makeWorld()
        await open(w, total: 130, lastRead: 130)
        XCTAssertEqual(state(w).unreadCount, 0)
        try w.server.post(channelId: w.channel.id, senderId: w.alice.id, body: "alice joined", type: "system")
        await settle(w.engine)
        XCTAssertEqual(state(w).unreadCount, 0)
        XCTAssertNil(state(w).firstUnreadAt)
        XCTAssertEqual(serverRead(w).unreadCount, 0)
        let (post, _) = try w.server.post(channelId: w.channel.id, senderId: w.alice.id, body: "hello")
        await settle(w.engine)
        XCTAssertEqual(state(w).unreadCount, 1)
        XCTAssertEqual(state(w).firstUnreadAt, post.createdAt)
        XCTAssertEqual(serverRead(w).unreadCount, 1)
        XCTAssertEqual(serverRead(w).firstUnreadAt, post.createdAt)
        XCTAssertEqual(ReadGate.firstUnreadRow(w.store.messages(w.channel.id), afterSeq: 130, meId: w.bob.id)?.body, "alice joined")
        w.engine.stop()
    }

    /// §10.1 6.: 「最初の未読へ」 pages back to the read position as it was when pressed, not as it is when the engine's
    /// queue gets to it (a read.updated already queued lowers it meanwhile).
    func testTheJumpTargetIsTheReadPositionWhenPressed() async throws {
        let w = makeWorld()
        await open(w, total: 1300, lastRead: 1000)
        try w.server.markRead(userId: w.bob.id, channelId: w.channel.id, seq: 800, mode: "set") // queued, not applied yet
        XCTAssertEqual(state(w).lastReadSeq, 1000)
        let covered = try await w.engine.loadFirstUnread(w.channel.id)
        XCTAssertTrue(covered)
        XCTAssertEqual(state(w).lastReadSeq, 800)
        XCTAssertEqual(Array(w.api.historyRequests.dropFirst()), ["before_seq=1251&limit=200", "before_seq=1051&limit=200"]) // to 851, not 651
        w.engine.stop()
    }

    func testV12SetBelowTheWindowStopsVisibleMarks() async throws {
        let w = makeWorld(pageSize: 101)
        await open(w, total: 1500, lastRead: 1450)
        XCTAssertEqual(state(w).oldestLoadedSeq, 1400)
        XCTAssertTrue(w.engine.readRangeReady(w.channel.id))
        await read(w, 1460)
        XCTAssertEqual(serverRead(w).lastReadSeq, 1460)
        try w.server.markRead(userId: w.bob.id, channelId: w.channel.id, seq: 900, mode: "set")
        await settle(w.engine)
        XCTAssertEqual(state(w).unreadCount, 600)
        XCTAssertFalse(w.engine.readRangeReady(w.channel.id))
        await read(w, 1500)
        XCTAssertEqual(serverRead(w).lastReadSeq, 900)
        XCTAssertEqual(ReadGate.banner(state(w), focused: false, positioned: true, anchored: false, held: false, jumping: false, status: .online)?.jump, false)
        try w.server.markRead(userId: w.bob.id, channelId: w.channel.id, seq: 1100, mode: "set")
        await settle(w.engine)
        XCTAssertEqual(state(w).unreadCount, 400)
        XCTAssertFalse(w.engine.readRangeReady(w.channel.id))
        XCTAssertEqual(ReadGate.banner(state(w), focused: false, positioned: true, anchored: false, held: false, jumping: false, status: .online)?.jump, true)
        w.engine.stop()
    }

    func testV13MarkUnreadHoldsAndMovesTheDivider() async {
        let w = makeWorld()
        await open(w, total: 130, lastRead: 100)
        w.engine.markUnread(w.channel.id, seq: 110)
        await w.engine.flushReads()
        await settle(w.engine)
        XCTAssertEqual(serverRead(w).lastReadSeq, 109)
        XCTAssertEqual(w.engine.unreadHold[w.channel.id], 109)
        XCTAssertEqual(state(w).firstUnreadAt, w.server.channels[w.channel.id]?.messages[109].createdAt) // seq 110
        await read(w, 130) // paused by the hold
        XCTAssertEqual(serverRead(w).lastReadSeq, 109)
        XCTAssertNil(ReadGate.banner(state(w), focused: false, positioned: true, anchored: false, held: true, jumping: false, status: .online))
        XCTAssertEqual(ReadGate.dividerMark(held: w.engine.unreadHold[w.channel.id], captured: 100, oldestLoadedSeq: state(w).oldestLoadedSeq), 109)
        w.engine.stop()
    }

    func testV14RowsThatAreNotUnreadDoNotBlockReading() async {
        let w = makeWorld()
        w.server.seed(w.channel.id, senderId: w.alice.id, count: 100)
        w.server.seed(w.channel.id, senderId: w.alice.id, count: 60, type: "system")
        await open(w, total: 0, lastRead: 100)
        XCTAssertEqual(state(w).unreadCount, 0)
        XCTAssertEqual(state(w).oldestLoadedSeq, 111)
        XCTAssertTrue(w.engine.readRangeReady(w.channel.id))
        await read(w, 160)
        XCTAssertEqual(serverRead(w).lastReadSeq, 160)
        XCTAssertNil(ReadGate.banner(state(w), focused: false, positioned: true, anchored: false, held: false, jumping: false, status: .online))
        w.engine.stop()
    }

    func testV15JumpStopsAfterFourPagesAndContinues() async throws {
        let w = makeWorld()
        w.server.seed(w.channel.id, senderId: w.alice.id, count: 1000)
        for _ in 0..<300 {
            w.server.seed(w.channel.id, senderId: w.alice.id, count: 1)
            w.server.seed(w.channel.id, senderId: w.alice.id, count: 3, type: "system")
        }
        await open(w, total: 0, lastRead: 1000)
        XCTAssertEqual(state(w).lastSeq, 2200)
        XCTAssertEqual(state(w).unreadCount, 300)
        XCTAssertEqual(state(w).oldestLoadedSeq, 2151)
        var covered = try await w.engine.loadFirstUnread(w.channel.id)
        XCTAssertFalse(covered)
        XCTAssertEqual(w.api.historyRequests.dropFirst().map { $0 }, ["before_seq=2151&limit=200", "before_seq=1951&limit=200", "before_seq=1751&limit=200",
                                                                      "before_seq=1551&limit=200"])
        XCTAssertEqual(state(w).oldestLoadedSeq, 1351)
        XCTAssertFalse(w.engine.readRangeReady(w.channel.id))
        covered = try await w.engine.loadFirstUnread(w.channel.id)
        XCTAssertTrue(covered)
        XCTAssertEqual(w.api.historyRequests.suffix(2), ["before_seq=1351&limit=200", "before_seq=1151&limit=200"])
        XCTAssertEqual(state(w).oldestLoadedSeq, 951)
        XCTAssertEqual(ReadGate.firstUnreadRow(w.store.messages(w.channel.id), afterSeq: 1000, meId: w.bob.id)?.seq, 1001)
        w.engine.stop()
    }

    func testV16OfflineJumpMakesNoRequest() async throws {
        let w = makeWorld()
        await open(w, total: 1300, lastRead: 1000)
        w.engine.stop()
        let covered = try await w.engine.loadFirstUnread(w.channel.id)
        XCTAssertFalse(covered)
        XCTAssertEqual(w.api.historyRequests, ["before_seq=nil&limit=50"])
        let banner = ReadGate.banner(state(w), focused: false, positioned: true, anchored: false, held: false, jumping: false, status: w.engine.status)
        XCTAssertEqual(banner?.enabled, false)
        XCTAssertEqual(banner?.jump, true)
    }

    func testJumpErrorsReachTheCaller() async {
        let w = makeWorld()
        await open(w, total: 1300, lastRead: 1000)
        w.api.failures["history"] = [ApiError.api(status: 503, code: "unavailable", message: "")]
        do {
            _ = try await w.engine.loadFirstUnread(w.channel.id)
            XCTFail("the error is shown by the caller")
        } catch {
            XCTAssertEqual((error as? ApiError)?.code, "unavailable")
        }
        let covered = try? await w.engine.loadFirstUnread(w.channel.id) // pressed again: continues from the same start
        XCTAssertEqual(covered, true)
        w.engine.stop()
    }

    func testV28ForceIgnoresTheGate() async {
        let w = makeWorld()
        await open(w, total: 60, lastRead: 0)
        XCTAssertEqual(state(w).oldestLoadedSeq, 11)
        XCTAssertEqual(state(w).hasOlder, true)
        await read(w, 60)
        XCTAssertEqual(state(w).lastReadSeq, 0)
        XCTAssertEqual(state(w).unreadCount, 60)
        XCTAssertEqual(putCount(w), 0)
        XCTAssertTrue(w.store.unsentReads.isEmpty)
        await read(w, 60, force: true)
        XCTAssertEqual(putCount(w), 1)
        XCTAssertEqual(serverRead(w).lastReadSeq, 60)
        XCTAssertEqual(state(w).unreadCount, 0)
        XCTAssertNil(state(w).firstUnreadAt)
        w.engine.stop()
    }

    func testV29FirstUnreadAtFollowsTheCounts() async throws {
        let w = makeWorld()
        await open(w, total: 0, lastRead: 0)
        XCTAssertEqual(state(w).unreadCount, 0)
        XCTAssertNil(state(w).firstUnreadAt)
        let (m1, _) = try w.server.post(channelId: w.channel.id, senderId: w.alice.id, body: "11:00")
        let (m2, _) = try w.server.post(channelId: w.channel.id, senderId: w.alice.id, body: "11:01")
        await settle(w.engine)
        XCTAssertEqual(state(w).unreadCount, 2)
        XCTAssertEqual(state(w).firstUnreadAt, m1.createdAt) // 0 → 1 only
        await read(w, 2)
        XCTAssertNil(state(w).firstUnreadAt) // reached last_seq
        w.engine.markUnread(w.channel.id, seq: 2)
        XCTAssertEqual(state(w).firstUnreadAt, m2.createdAt) // the first row counted again
        await w.engine.flushReads()
        await settle(w.engine)
        XCTAssertEqual(state(w).firstUnreadAt, m2.createdAt) // the PUT response agrees
        try w.server.markRead(userId: w.bob.id, channelId: w.channel.id, seq: 0, mode: "set") // read.updated from another device
        await settle(w.engine)
        XCTAssertEqual(state(w).firstUnreadAt, m1.createdAt)
        try await w.engine.markAllRead()
        XCTAssertNil(state(w).firstUnreadAt)
        XCTAssertNil(Store.fromSnapshot(w.store.snapshot()).channel(w.channel.id)?.firstUnreadAt)
        let (m3, _) = try w.server.post(channelId: w.channel.id, senderId: w.alice.id, body: "later")
        await settle(w.engine)
        XCTAssertEqual(Store.fromSnapshot(w.store.snapshot()).channel(w.channel.id)?.firstUnreadAt, m3.createdAt) // persisted with the channel
        w.engine.stop()
    }

    // MARK: threads (§10.2)

    /// V24 setup: parent at seq 500, replies r1...r30 at 501...530, bob's thread position 510; this device holds only r29, r30.
    private func openThread(_ w: World) async throws -> MessageOut {
        let rows = w.server.seed(w.channel.id, senderId: w.alice.id, count: 500)
        let parent = rows[499]
        for i in 1...28 { try w.server.post(channelId: w.channel.id, senderId: w.alice.id, body: "r\(i)", parentId: parent.id) }
        w.server.threadFollows["\(parent.id):\(w.bob.id)"] = FakeServer.ThreadFollow(parentId: parent.id, userId: w.bob.id, following: true, lastReadSeq: 510, order: 99)
        w.server.readPositions["\(w.bob.id):\(w.channel.id)"] = 500
        await w.engine.openChannel(w.channel.id)
        await w.engine.start()
        await settle(w.engine)
        for i in 29...30 { try w.server.post(channelId: w.channel.id, senderId: w.alice.id, body: "r\(i)", parentId: parent.id) }
        await settle(w.engine)
        XCTAssertEqual(w.store.replies(w.channel.id, parentId: parent.id).map(\.body), ["r29", "r30"])
        await w.engine.loadThreadState(parent.id)
        XCTAssertEqual(w.store.threads[parent.id]?.state.lastReadSeq, 510)
        return parent
    }

    private func threadPuts(_ w: World) -> Int { w.api.calls.filter { $0 == "markThreadRead" }.count }

    func testV24ThreadMarksOnlyOnceComplete() async throws {
        let w = makeWorld()
        let parent = try await openThread(w)
        XCTAssertFalse(w.engine.threadComplete(parent.id))
        w.engine.markThreadRead(parent.id, seq: 530) // r29, r30 on screen before the replies arrive
        await w.engine.flushReads()
        XCTAssertEqual(threadPuts(w), 0)
        XCTAssertEqual(w.store.threads[parent.id]?.state.lastReadSeq, 510)

        let loaded = await w.engine.loadReplies(w.channel.id, parentId: parent.id)
        XCTAssertTrue(loaded)
        XCTAssertTrue(w.engine.threadComplete(parent.id))
        let replies = w.store.replies(w.channel.id, parentId: parent.id)
        XCTAssertEqual(replies.count, 30)
        XCTAssertEqual(ReadGate.threadTarget(replies, focusId: nil, lastReadSeq: 510, meId: w.bob.id), .top(replies[10].rowKey)) // r11
        XCTAssertNotEqual(replies[10].rowKey, replies[10].id)
        w.engine.markThreadRead(parent.id, seq: 518) // r11...r18 on screen
        await w.engine.flushThreads()
        await settle(w.engine)
        XCTAssertEqual(try w.server.threadState(userId: w.bob.id, parentId: parent.id).lastReadSeq, 518)
        w.engine.stop()
    }

    func testV25ClearingTheChannelForgetsCompleteThreads() async throws {
        let w = makeWorld(gapLimit: 10)
        let parent = try await openThread(w)
        await w.engine.loadReplies(w.channel.id, parentId: parent.id)
        XCTAssertTrue(w.engine.threadComplete(parent.id))
        await reconnect(w) { w.server.seed(w.channel.id, senderId: w.alice.id, count: 20) } // far behind: §7.3 reload
        XCTAssertEqual(w.engine.reloads, 1)
        XCTAssertFalse(w.engine.threadComplete(parent.id))
        w.engine.markThreadRead(parent.id, seq: 520)
        await w.engine.flushReads()
        XCTAssertEqual(threadPuts(w), 0)
        let loaded = await w.engine.loadReplies(w.channel.id, parentId: parent.id)
        XCTAssertTrue(loaded)
        w.engine.markThreadRead(parent.id, seq: 520)
        await w.engine.flushThreads()
        await settle(w.engine)
        XCTAssertEqual(try w.server.threadState(userId: w.bob.id, parentId: parent.id).lastReadSeq, 520)

        w.server.removeMember(w.channel.id, w.bob.id) // removed from the channel: its rows go too
        await settle(w.engine)
        XCTAssertFalse(w.engine.threadComplete(parent.id))
        w.engine.stop()
    }

    /// A reply's thread.updated can carry the server's position from before this device's mark reached it (the PUT is
    /// debounced, or failed and waits for the next connection). The local position never steps back: the open thread
    /// would otherwise find its first unread reply above the screen again and stop marking (§10.2).
    func testThreadUpdatedNeverStepsBackBelowTheLocalPosition() async throws {
        let w = makeWorld()
        let parent = try await openThread(w)
        await w.engine.loadReplies(w.channel.id, parentId: parent.id)
        w.api.failures["markThreadRead"] = [ApiError.network(URLError(.networkConnectionLost))]
        w.engine.markThreadRead(parent.id, seq: 518)
        await w.engine.flushReads()
        XCTAssertEqual(try w.server.threadState(userId: w.bob.id, parentId: parent.id).lastReadSeq, 510)
        XCTAssertEqual(w.store.threads[parent.id]?.state.lastReadSeq, 518)
        try w.server.post(channelId: w.channel.id, senderId: w.alice.id, body: "r31", parentId: parent.id) // thread.updated: 510
        await settle(w.engine)
        XCTAssertEqual(w.store.threads[parent.id]?.state.lastReadSeq, 518)
        w.engine.stop()
    }

    /// V49 (§10.2): a §7.3 reload of the channel while online (a live gap far behind) drops the open thread's complete
    /// flag with no status change. Marks wait until the replies are fetched again, which ThreadView does as its fetch
    /// is keyed on the flag.
    func testV49AReloadWhileOnlineDropsTheThreadUntilItIsFetchedAgain() async throws {
        let w = makeWorld(gapLimit: 10)
        let parent = try await openThread(w)
        _ = await w.engine.loadReplies(w.channel.id, parentId: parent.id)
        XCTAssertTrue(w.engine.threadComplete(parent.id))
        let reconnects = w.engine.reconnects
        w.server.seed(w.channel.id, senderId: w.alice.id, count: 20) // missed
        try w.server.post(channelId: w.channel.id, senderId: w.alice.id, body: "live") // the gap is far behind: reload
        await settle(w.engine)
        XCTAssertEqual(w.engine.reloads, 1)
        XCTAssertEqual(w.engine.status, .online)
        XCTAssertEqual(w.engine.reconnects, reconnects)
        XCTAssertFalse(w.engine.threadComplete(parent.id))
        XCTAssertTrue(w.store.replies(w.channel.id, parentId: parent.id).isEmpty)
        w.engine.markThreadRead(parent.id, seq: 520)
        await w.engine.flushReads()
        XCTAssertEqual(threadPuts(w), 0)
        let loaded = await w.engine.loadReplies(w.channel.id, parentId: parent.id)
        XCTAssertTrue(loaded)
        w.engine.markThreadRead(parent.id, seq: 520)
        await w.engine.flushThreads()
        await settle(w.engine)
        XCTAssertEqual(try w.server.threadState(userId: w.bob.id, parentId: parent.id).lastReadSeq, 520)
        w.engine.stop()
    }

    /// V52 (§10.2): a reply's thread.updated arrives while my thread read is still in its debounce, with the server's
    /// older position. The local position stays, and so does the open thread's anchor.
    func testV52ADebouncedThreadReadIsNotSteppedBack() async throws {
        var debouncing = true
        let w = makeWorld(sleep: { _ in while debouncing { await Task.yield() } })
        let parent = try await openThread(w)
        _ = await w.engine.loadReplies(w.channel.id, parentId: parent.id)
        var anchor = ReadAnchor()
        func look(_ shown: ClosedRange<Int>) -> Int? {
            let replies = w.store.replies(w.channel.id, parentId: parent.id)
            let visible = replies.filter { shown.contains($0.seq ?? 0) }
            let state = w.engine.threadComplete(parent.id) ? w.store.threads[parent.id]?.state : nil
            return anchor.observe(unreadCount: nil, ready: state != nil,
                                  firstUnread: state.flatMap { ReadGate.firstUnreadRow(replies, afterSeq: $0.lastReadSeq, meId: w.bob.id) },
                                  visible: visible, onScreenIds: Set(visible.map(\.id)))
        }
        XCTAssertEqual(look(511...518), 518)
        w.engine.markThreadRead(parent.id, seq: 518)
        try w.server.post(channelId: w.channel.id, senderId: w.alice.id, body: "r31", parentId: parent.id) // thread.updated: 510
        await settle(w.engine)
        XCTAssertEqual(try w.server.threadState(userId: w.bob.id, parentId: parent.id).lastReadSeq, 510) // the PUT still waits
        XCTAssertEqual(w.store.threads[parent.id]?.state.lastReadSeq, 518)
        XCTAssertEqual(look(515...522), 522) // reading on: 511...518 are not found above the screen again
        XCTAssertTrue(anchor.anchored)
        debouncing = false
        await w.engine.flushThreads()
        await settle(w.engine)
        XCTAssertEqual(try w.server.threadState(userId: w.bob.id, parentId: parent.id).lastReadSeq, 518)
        w.engine.stop()
    }

    /// V52 (§10.2) through the other paths that replace a thread's state: the threads list refresh that every
    /// thread.updated schedules once the list was opened, and the follow change's response. Both carry the server's
    /// position from before my debounced PUT; neither takes the open thread back to it.
    func testV52TheThreadsListAndFollowResponsesKeepTheLocalPosition() async throws {
        var debouncing = true
        let w = makeWorld(sleep: { _ in while debouncing { await Task.yield() } })
        let parent = try await openThread(w)
        _ = await w.engine.loadReplies(w.channel.id, parentId: parent.id)
        await w.engine.loadThreads(filter: "all") // the スレッド list was opened in this session
        XCTAssertTrue(w.store.threadsLoaded)
        var anchor = ReadAnchor()
        func look(_ shown: ClosedRange<Int>) -> Int? {
            let replies = w.store.replies(w.channel.id, parentId: parent.id)
            let visible = replies.filter { shown.contains($0.seq ?? 0) }
            let state = w.engine.threadComplete(parent.id) ? w.store.threads[parent.id]?.state : nil
            return anchor.observe(unreadCount: nil, ready: state != nil,
                                  firstUnread: state.flatMap { ReadGate.firstUnreadRow(replies, afterSeq: $0.lastReadSeq, meId: w.bob.id) },
                                  visible: visible, onScreenIds: Set(visible.map(\.id)))
        }
        XCTAssertEqual(look(511...530), 530)
        w.engine.markThreadRead(parent.id, seq: 530)
        XCTAssertEqual(w.store.threads[parent.id]?.state.unreadCount, 0)
        await w.engine.loadThreads(filter: "all") // what the refresh after a thread.updated runs
        XCTAssertEqual(try w.server.threadState(userId: w.bob.id, parentId: parent.id).lastReadSeq, 510) // the PUT still waits
        XCTAssertEqual(w.store.threads[parent.id]?.state.lastReadSeq, 530)
        XCTAssertEqual(w.store.threads[parent.id]?.state.unreadCount, 0)
        await w.engine.setThreadFollow(parent.id, following: false)
        await settle(w.engine)
        XCTAssertEqual(w.store.threads[parent.id]?.state.following, false)
        XCTAssertEqual(w.store.threads[parent.id]?.state.lastReadSeq, 530)
        XCTAssertEqual(look(515...530), 530)
        XCTAssertTrue(anchor.anchored)
        debouncing = false
        await w.engine.flushThreads()
        await settle(w.engine)
        XCTAssertEqual(try w.server.threadState(userId: w.bob.id, parentId: parent.id).lastReadSeq, 530)
        w.engine.stop()
    }

    /// V53 (§10.2): every path that drops a channel here forgets its complete threads, among them leaving it while the
    /// member_removed event was missed (the next bootstrap does not list it). Joined again, the thread takes no marks
    /// until its replies are fetched again.
    func testV53ADroppedChannelForgetsItsCompleteThreads() async throws {
        let w = makeWorld()
        let parent = try await openThread(w)
        _ = await w.engine.loadReplies(w.channel.id, parentId: parent.id)
        XCTAssertTrue(w.engine.threadComplete(parent.id))
        await reconnect(w) { w.server.removeMember(w.channel.id, w.bob.id) } // no socket: the event is lost
        XCTAssertNotEqual(w.store.channel(w.channel.id)?.isMember, true) // at most listed as a public channel to browse
        XCTAssertFalse(w.engine.threadComplete(parent.id))
        w.server.join(w.channel.id, w.bob.id)
        w.server.emitMembership(w.channel.id, w.bob.id)
        await settle(w.engine)
        XCTAssertEqual(w.store.channel(w.channel.id)?.isMember, true)
        w.engine.markThreadRead(parent.id, seq: 520)
        await w.engine.flushReads()
        XCTAssertEqual(threadPuts(w), 0)
        let loaded = await w.engine.loadReplies(w.channel.id, parentId: parent.id)
        XCTAssertTrue(loaded)
        w.engine.markThreadRead(parent.id, seq: 520)
        await w.engine.flushThreads()
        await settle(w.engine)
        XCTAssertEqual(try w.server.threadState(userId: w.bob.id, parentId: parent.id).lastReadSeq, 520)
        w.engine.stop()
    }

    func testV26NothingUnreadOpensAtTheBottom() async throws {
        let w = makeWorld()
        let parent = try await openThread(w)
        await w.engine.loadReplies(w.channel.id, parentId: parent.id)
        try w.server.markThreadRead(userId: w.bob.id, messageId: parent.id, seq: 530)
        await settle(w.engine)
        XCTAssertEqual(w.store.threads[parent.id]?.state.lastReadSeq, 530)
        let replies = w.store.replies(w.channel.id, parentId: parent.id)
        XCTAssertEqual(ReadGate.threadTarget(replies, focusId: nil, lastReadSeq: 530, meId: w.bob.id), .bottom)
        let puts = threadPuts(w)
        w.engine.markThreadRead(parent.id, seq: 530)
        await w.engine.flushReads()
        XCTAssertEqual(threadPuts(w), puts) // not past the current position
        w.engine.stop()
    }

    func testV27FailedRepliesKeepTheThreadIncomplete() async throws {
        let w = makeWorld()
        let parent = try await openThread(w)
        w.api.failures["replies"] = [ApiError.network(URLError(.notConnectedToInternet))]
        var loaded = await w.engine.loadReplies(w.channel.id, parentId: parent.id)
        XCTAssertFalse(loaded)
        XCTAssertFalse(w.engine.threadComplete(parent.id))
        w.engine.markThreadRead(parent.id, seq: 530)
        await w.engine.flushReads()
        XCTAssertEqual(threadPuts(w), 0)
        w.engine.stop()
        loaded = await w.engine.loadReplies(w.channel.id, parentId: parent.id) // offline
        XCTAssertFalse(loaded)
        await w.engine.start()
        await settle(w.engine)
        loaded = await w.engine.loadReplies(w.channel.id, parentId: parent.id)
        XCTAssertTrue(loaded)
        XCTAssertTrue(w.engine.threadComplete(parent.id))
        w.engine.stop()
    }
}
