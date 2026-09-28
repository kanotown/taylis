import XCTest
@testable import ChikuwaChat

/// The pure rules of SYNC_PROTOCOL.md §10.1–§10.3 (the §10.4 vectors for the pure helpers and the view decisions built on them).
final class ReadGateTests: XCTestCase {
    private var calendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Asia/Tokyo")!
        calendar.locale = Locale(identifier: "en_US") // the labels must not follow the locale
        return calendar
    }()
    private let now = parseIsoDate("2026-09-28T15:00:00+09:00")! // Monday, 15:00 local

    /// A confirmed row as the server sends it: client_msg_id differs from id, so rowKey is not the id (§10.3).
    private func row(_ seq: Int, sender: String = "alice") -> MessageState {
        var message = MessageState(placeholderFor: "cmid-\(seq)", channelId: "c", senderId: sender, body: "m\(seq)", createdAt: "2026-09-28T01:00:00Z")
        message.id = "id-\(seq)"
        message.seq = seq
        message.updatedSeq = seq
        message.pending = false
        return message
    }

    private func channel(lastSeq: Int, lastRead: Int, unread: Int, oldest: Int?, firstUnreadAt: String? = "2026-09-28T10:23:00+09:00") -> ChannelState {
        let out = ChannelOut(id: "c", type: "public", name: "general", topic: nil, purpose: nil, archived: false, createdBy: nil, lastSeq: lastSeq,
                             lastMessageAt: nil, createdAt: "", updatedAt: "", membership: nil, dmUserIds: nil)
        return ChannelState(channel: out, isMember: true, syncedSeq: lastSeq, lastSeq: lastSeq, lastReadSeq: lastRead, unreadCount: unread, hasOlder: oldest != 0,
                            oldestLoadedSeq: oldest, firstUnreadAt: firstUnreadAt)
    }

    private func shape(_ items: [TimelineItem]) -> [String] {
        items.compactMap { item in
            switch item {
            case .date: return nil
            case .unread: return "unread"
            case .message(let message, _): return message.seq.map(String.init)
            }
        }
    }

    func testCoversV22() {
        XCTAssertTrue(ReadGate.covers(0, 5))
        XCTAssertFalse(ReadGate.covers(nil, 5))
        XCTAssertTrue(ReadGate.covers(6, 5))
        XCTAssertFalse(ReadGate.covers(7, 5))
    }

    func testReadRangeReadyNeedsTheUnreadRowsOrNothingUnread() {
        XCTAssertTrue(ReadGate.readRangeReady(channel(lastSeq: 130, lastRead: 100, unread: 30, oldest: 81))) // V1
        XCTAssertFalse(ReadGate.readRangeReady(channel(lastSeq: 3000, lastRead: 1000, unread: 2000, oldest: 2951))) // V2
        XCTAssertFalse(ReadGate.readRangeReady(channel(lastSeq: 153, lastRead: 100, unread: 50, oldest: 104))) // V5: seqs skip replies
        XCTAssertTrue(ReadGate.readRangeReady(channel(lastSeq: 160, lastRead: 100, unread: 0, oldest: 111))) // V14: system rows only
        XCTAssertFalse(ReadGate.readRangeReady(channel(lastSeq: 60, lastRead: 0, unread: 60, oldest: 11))) // V28
        XCTAssertFalse(ReadGate.readRangeReady(channel(lastSeq: 60, lastRead: 0, unread: 60, oldest: nil))) // no page yet
    }

    /// V32: the window must also reach last_seq. Bootstrap raised it after the app was away (read to 130 here, 300 new
    /// since): nothing after 130 is held, so the unread rows are not "all loaded" although covers(81, 130) holds.
    func testReadRangeReadyNeedsTheNewestSideToo() {
        var stale = channel(lastSeq: 430, lastRead: 130, unread: 300, oldest: 81)
        stale.syncedSeq = 130
        XCTAssertTrue(ReadGate.covers(stale.oldestLoadedSeq, stale.lastReadSeq))
        XCTAssertFalse(ReadGate.reachesNewest(stale))
        XCTAssertFalse(ReadGate.readRangeReady(stale))
        stale.syncedSeq = 430 // the catch-up's next_since_seq ends at the channel's last_seq
        XCTAssertTrue(ReadGate.readRangeReady(stale))
        stale.syncedSeq = nil
        XCTAssertFalse(ReadGate.reachesNewest(stale))
        stale.unreadCount = 0 // nothing unread: nothing to skip
        XCTAssertTrue(ReadGate.readRangeReady(stale))
        stale.syncedSeq = 130 // V32's third case: {unread 0, synced 130, last 430}
        XCTAssertTrue(ReadGate.readRangeReady(stale))
    }

    /// V33 / §10.1 5.: back after 300 new messages, bootstrap in, the catch-up not yet: no unread row is held, and the
    /// banner waits for the rows instead of flashing on every reconnect. Offline nothing comes, so it shows.
    func testV33BannerWaitsForTheCatchUpWhileNoUnreadRowIsHeld() {
        var stale = channel(lastSeq: 430, lastRead: 130, unread: 300, oldest: 81)
        stale.syncedSeq = 130
        let rows = (81...130).map { row($0) }
        let held = ReadGate.firstUnreadRow(rows, afterSeq: stale.lastReadSeq, meId: "bob") != nil
        XCTAssertFalse(held)
        XCTAssertTrue(ReadGate.catchingUp(stale, status: .online))
        XCTAssertNil(ReadGate.banner(stale, focused: false, positioned: true, anchored: false, held: false, jumping: false, status: .online, firstUnreadHeld: held))
        XCTAssertNil(ReadGate.banner(stale, focused: false, positioned: true, anchored: false, held: false, jumping: false, status: .connecting, firstUnreadHeld: held))
        XCTAssertEqual(ReadGate.banner(stale, focused: false, positioned: true, anchored: false, held: false, jumping: false, status: .offline,
                                       firstUnreadHeld: held, now: now, calendar: calendar),
                       ReadGate.Banner(text: "未読 300 件 · 10:23 以降", jump: true, loading: false, enabled: false))
        // An unread row already held (a partial catch-up): the banner is about rows that are here.
        XCTAssertNotNil(ReadGate.banner(stale, focused: false, positioned: true, anchored: false, held: false, jumping: false, status: .online, firstUnreadHeld: true))
        // V34: the delta is in, the list followed the bottom past row 131: the banner with both buttons.
        var caughtUp = stale
        caughtUp.syncedSeq = 430
        XCTAssertFalse(ReadGate.catchingUp(caughtUp, status: .online))
        XCTAssertEqual(ReadGate.banner(caughtUp, focused: false, positioned: true, anchored: false, held: false, jumping: false, status: .online,
                                       firstUnreadHeld: true, now: now, calendar: calendar),
                       ReadGate.Banner(text: "未読 300 件 · 10:23 以降", jump: true, loading: false, enabled: true))
    }

    /// V35 / §10.1 4.: a channel opened while its catch-up is on its way is placed after it (the divider's row comes
    /// with it); not when offline, once the reader dragged, or after the 3 s wait.
    func testV35PlacementWaitsForTheCatchUp() {
        var stale = channel(lastSeq: 430, lastRead: 130, unread: 300, oldest: 81)
        stale.syncedSeq = 130
        XCTAssertTrue(ReadGate.placementWaits(stale, status: .online, userScrolled: false, waitOver: false))
        XCTAssertTrue(ReadGate.placementWaits(stale, status: .connecting, userScrolled: false, waitOver: false))
        XCTAssertFalse(ReadGate.placementWaits(stale, status: .offline, userScrolled: false, waitOver: false))
        XCTAssertFalse(ReadGate.placementWaits(stale, status: nil, userScrolled: false, waitOver: false))
        XCTAssertFalse(ReadGate.placementWaits(stale, status: .online, userScrolled: true, waitOver: false))
        XCTAssertFalse(ReadGate.placementWaits(stale, status: .online, userScrolled: false, waitOver: true))
        var browsing = stale
        browsing.isMember = false // nothing to catch up
        XCTAssertFalse(ReadGate.placementWaits(browsing, status: .online, userScrolled: false, waitOver: false))
        // The delta is in: placed at the divider (mark 130), row 131 right below it.
        var caughtUp = stale
        caughtUp.syncedSeq = 430
        XCTAssertFalse(ReadGate.placementWaits(caughtUp, status: .online, userScrolled: false, waitOver: false))
        let rows = (81...430).map { row($0) }
        let mark = ReadGate.dividerMark(held: nil, captured: ReadGate.openMark(caughtUp), oldestLoadedSeq: caughtUp.oldestLoadedSeq)
        XCTAssertEqual(mark, 130)
        XCTAssertEqual(ReadGate.openTarget(rows, focusId: nil, mark: mark, meId: "bob"), .top("cmid-131"))
        // Placed before the delta (the rows held end at 130), it would have opened at the bottom.
        XCTAssertEqual(ReadGate.openTarget(Array(rows.prefix(50)), focusId: nil, mark: mark, meId: "bob"), .bottom)
    }

    /// V38 / §10.1 10.: 「ここから未読にする」 moves the position forward only while every unread row is held.
    func testV38MarkUnreadIsOfferedForwardOnlyWhenReady() {
        let v2 = channel(lastSeq: 3000, lastRead: 1000, unread: 2000, oldest: 2951)
        XCTAssertFalse(ReadGate.markUnreadOffered(v2, seq: 2990)) // would read 1001...2989 unseen
        XCTAssertTrue(ReadGate.markUnreadOffered(v2, seq: 1001)) // position unchanged
        XCTAssertTrue(ReadGate.markUnreadOffered(v2, seq: 900)) // backwards: always (the search context too)
        let v1 = channel(lastSeq: 130, lastRead: 115, unread: 15, oldest: 81)
        XCTAssertTrue(ReadGate.markUnreadOffered(v1, seq: 125)) // PUT {124, set}
        var stale = v1
        stale.lastSeq = 430
        stale.unreadCount = 315
        XCTAssertFalse(ReadGate.markUnreadOffered(stale, seq: 125)) // a catch-up still on its way
        XCTAssertTrue(ReadGate.markUnreadOffered(channel(lastSeq: 3000, lastRead: 1000, unread: 0, oldest: 2951), seq: 2990)) // nothing unread
    }

    /// V40 / §10.1 7.: the list starts at the bottom before it is placed at the divider; that is not "seen", so the
    /// button still counts the 30 unread rows. After placing, being at the bottom sees the newest row.
    func testV40TheBottomBeforePlacingIsNotSeen() {
        let v1 = (81...130).map { row($0) }
        let seen = ReadGate.seenAtBottom(100, rows: v1, placed: false)
        XCTAssertEqual(seen, 100)
        XCTAssertEqual(ReadGate.newBelow(v1, seenSeq: seen, meId: "bob"), 30) // 「新着 30 件」
        XCTAssertEqual(ReadGate.seenAtBottom(100, rows: v1, placed: true), 130)
        XCTAssertEqual(ReadGate.seenAtBottom(140, rows: v1, placed: true), 140) // never backwards
        XCTAssertNil(ReadGate.seenAtBottom(nil, rows: [], placed: true))
        // V39: after 「最初の未読へ」 the count starts at the mark (1000); the frames still at the bottom during the landing
        // do not move it, so the button says 「新着 300 件」.
        let v4 = (851...1300).map { row($0) }
        let landing = ReadGate.seenAtBottom(1000, rows: v4, placed: false)
        XCTAssertEqual(ReadGate.newBelow(v4, seenSeq: landing, meId: "bob"), 300)
    }

    /// V43 / §10.1 11.: only this device's own pending top-level post takes the timeline to the bottom.
    func testV43OnlyMyPendingTopLevelPostFollowsTheBottom() {
        let mine = MessageState(placeholderFor: "k1", channelId: "c", senderId: "bob", body: "hi", createdAt: "2026-09-28T01:00:00Z")
        XCTAssertTrue(ReadGate.ownPendingPost(mine, meId: "bob"))
        let reply = MessageState(placeholderFor: "k2", channelId: "c", senderId: "bob", body: "re", createdAt: "2026-09-28T01:00:00Z", parentId: "p",
                                 alsoInChannel: true)
        XCTAssertFalse(ReadGate.ownPendingPost(reply, meId: "bob")) // a reply also sent to the channel
        XCTAssertFalse(ReadGate.ownPendingPost(row(131, sender: "bob"), meId: "bob")) // from my other device, or scheduled
        XCTAssertFalse(ReadGate.ownPendingPost(row(131), meId: "bob"))
        XCTAssertFalse(ReadGate.ownPendingPost(mine, meId: nil))
        XCTAssertFalse(ReadGate.ownPendingPost(nil, meId: "bob"))
    }

    /// V48 / §10.1 4.: back from the search context the mark is taken again from the read position as it is now, and
    /// the view lands at the divider like an open (not at the bottom).
    func testV48BackFromTheSearchContextIsAFreshOpen() {
        let v1 = channel(lastSeq: 130, lastRead: 100, unread: 30, oldest: 81)
        let mark = ReadGate.openMark(v1)
        XCTAssertEqual(mark, 100)
        let rows = (81...130).map { row($0) }
        XCTAssertEqual(ReadGate.openTarget(rows, focusId: nil, mark: ReadGate.dividerMark(held: nil, captured: mark, oldestLoadedSeq: 81), meId: "bob"),
                       .top("cmid-101"))
        XCTAssertNil(ReadGate.openMark(channel(lastSeq: 130, lastRead: 130, unread: 0, oldest: 81))) // nothing unread: the bottom
        XCTAssertEqual(ReadGate.openTarget(rows, focusId: nil, mark: nil, meId: "bob"), .bottom)
    }

    /// §10.1 7. / V2: a view whose unread rows are not held opens at the bottom and counts from there, so the button is the
    /// plain arrow after scrolling up, never 「新着 50 件」 out of 2,000; after the jump (or at a V1 open) it is the true count.
    func testNewBelowCountsOnlyFromWhatWasSeen() {
        let v2 = (2951...3000).map { row($0) }
        XCTAssertEqual(ReadGate.openTarget(v2, focusId: nil, mark: ReadGate.dividerMark(held: nil, captured: 1000, oldestLoadedSeq: 2951), meId: "bob"), .bottom)
        XCTAssertEqual(ReadGate.newBelow(v2, seenSeq: v2.compactMap(\.seq).max(), meId: "bob"), 0) // seen at the bottom
        XCTAssertEqual(ReadGate.newBelow(v2 + [row(3001)], seenSeq: 3000, meId: "bob"), 1) // one arrived since
        XCTAssertEqual(ReadGate.newBelow((81...130).map { row($0) }, seenSeq: 100, meId: "bob"), 30) // V1: from the read position
        XCTAssertEqual(ReadGate.newBelow([row(131, sender: "bob")], seenSeq: 130, meId: "bob"), 0) // my own rows are not new
        XCTAssertEqual(ReadGate.newBelow(v2, seenSeq: nil, meId: "bob"), 0)
    }

    /// §10.1 7.: a reader who scrolled before the view was placed is left there; 「新着 N 件」 counts from the divider when
    /// it can be drawn, and never from the read position of a range that is not held (it would say 50 for 2,000 unread).
    func testSeenLeftInPlaceNeverCountsAPartialRange() {
        let v2 = (2951...3000).map { row($0) }
        let notHeld = ReadGate.dividerMark(held: nil, captured: 1000, oldestLoadedSeq: 2951)
        XCTAssertEqual(ReadGate.seenLeftInPlace(v2, dividerMark: notHeld), 3000)
        XCTAssertEqual(ReadGate.newBelow(v2, seenSeq: ReadGate.seenLeftInPlace(v2, dividerMark: notHeld), meId: "bob"), 0)
        let v1 = (81...130).map { row($0) }
        let held = ReadGate.dividerMark(held: nil, captured: 100, oldestLoadedSeq: 81)
        XCTAssertEqual(ReadGate.newBelow(v1, seenSeq: ReadGate.seenLeftInPlace(v1, dividerMark: held), meId: "bob"), 30)
        XCTAssertEqual(ReadGate.seenLeftInPlace(v1, dividerMark: nil), 130) // nothing unread
    }

    func testDividerMarkV23() {
        XCTAssertNil(ReadGate.dividerMark(held: nil, captured: 1000, oldestLoadedSeq: 2951))
        XCTAssertEqual(ReadGate.dividerMark(held: nil, captured: 1000, oldestLoadedSeq: 851), 1000)
        XCTAssertEqual(ReadGate.dividerMark(held: 109, captured: nil, oldestLoadedSeq: 81), 109)
        XCTAssertEqual(ReadGate.dividerMark(held: 109, captured: 100, oldestLoadedSeq: 81), 109) // V13: the hold wins
        XCTAssertEqual(ReadGate.dividerMark(held: nil, captured: 1000, oldestLoadedSeq: 1001), 1000) // V6: after the 5th page
        XCTAssertNil(ReadGate.dividerMark(held: nil, captured: nil, oldestLoadedSeq: 0))
    }

    func testJumpButtonV21() {
        XCTAssertTrue(ReadGate.jumpButtonShown(ready: false, unreadCount: 500))
        XCTAssertFalse(ReadGate.jumpButtonShown(ready: false, unreadCount: 501))
        XCTAssertTrue(ReadGate.jumpButtonShown(ready: true, unreadCount: 501))
    }

    func testBannerTextV18V19V20() {
        XCTAssertEqual(ReadGate.bannerText(300, firstUnreadAt: nil), "未読 300 件") // V18
        XCTAssertEqual(ReadGate.bannerText(12, firstUnreadAt: nil), "未読 12 件") // V19
        XCTAssertEqual(ReadGate.bannerText(999, firstUnreadAt: nil), "未読 999 件")
        XCTAssertEqual(ReadGate.bannerText(1234, firstUnreadAt: nil), "未読 1,234 件")
        XCTAssertEqual(ReadGate.bannerText(1_000_000, firstUnreadAt: nil), "未読 1,000,000 件")
        XCTAssertEqual(ReadGate.group3(0), "0")
        XCTAssertEqual(ReadGate.group3(100), "100")
        XCTAssertEqual(ReadGate.group3(123_456), "123,456")

        // V20: device time zone, 24 h, zero-padded, never the locale's format.
        XCTAssertEqual(ReadGate.sinceLabel("2026-09-28T10:23:00+09:00", now: now, calendar: calendar), "10:23")
        XCTAssertEqual(ReadGate.sinceLabel("2026-09-27T23:05:00+09:00", now: now, calendar: calendar), "昨日 23:05")
        XCTAssertEqual(ReadGate.sinceLabel("2026-09-26T09:07:00+09:00", now: now, calendar: calendar), "9月26日 (土) 09:07")
        XCTAssertEqual(ReadGate.sinceLabel("2025-12-31T10:23:00+09:00", now: now, calendar: calendar), "2025年12月31日 (水) 10:23")
        XCTAssertEqual(ReadGate.sinceLabel("2026-09-28T01:23:00.123456Z", now: now, calendar: calendar), "10:23") // the server's microseconds
        XCTAssertNil(ReadGate.sinceLabel("not a date", now: now, calendar: calendar))
        XCTAssertEqual(ReadGate.bannerText(2000, firstUnreadAt: "2026-09-28T10:23:00+09:00", now: now, calendar: calendar), "未読 2,000 件 · 10:23 以降")
        XCTAssertEqual(ReadGate.bannerText(5, firstUnreadAt: "garbage", now: now, calendar: calendar), "未読 5 件")
    }

    func testFirstUnreadRowSkipsMyRowsAndPendingOnes() {
        var pending = row(0, sender: "alice")
        pending.seq = nil
        let rows = [row(100), row(101, sender: "bob"), row(102), pending]
        XCTAssertEqual(ReadGate.firstUnreadRow(rows, afterSeq: 100, meId: "bob")?.seq, 102)
        XCTAssertNil(ReadGate.firstUnreadRow(rows, afterSeq: 102, meId: "bob"))
    }

    func testNextAnchoredFollowsTheRangeAndTheFirstUnreadRow() {
        let first = row(1001)
        // V2: not ready, whatever is visible.
        XCTAssertFalse(ReadGate.nextAnchored(false, unreadCount: 2000, ready: false, firstUnread: nil, visibleMessageIds: ["id-3000"]))
        // V3 / V9: nothing unread.
        XCTAssertTrue(ReadGate.nextAnchored(false, unreadCount: 0, ready: false, firstUnread: nil, visibleMessageIds: []))
        // V6: ready, but row 1001 is above the viewport; then it is shown.
        let viewport = Set((1045...1060).map { "id-\($0)" })
        XCTAssertFalse(ReadGate.nextAnchored(false, unreadCount: 300, ready: true, firstUnread: first, visibleMessageIds: viewport))
        XCTAssertTrue(ReadGate.nextAnchored(false, unreadCount: 300, ready: true, firstUnread: first, visibleMessageIds: ["id-1001", "id-1002"]))
        // Matched by message id, never by the row key.
        XCTAssertFalse(ReadGate.nextAnchored(false, unreadCount: 300, ready: true, firstUnread: first, visibleMessageIds: [first.rowKey]))
        // V11: once anchored it stays while the range is held; V10 / V12: it drops when the range is not.
        XCTAssertTrue(ReadGate.nextAnchored(true, unreadCount: 630, ready: true, firstUnread: row(501), visibleMessageIds: ["id-1130"]))
        XCTAssertFalse(ReadGate.nextAnchored(true, unreadCount: 6000, ready: false, firstUnread: nil, visibleMessageIds: ["id-6130"]))
        // Ready with no unread row from someone else: nothing to wait for.
        XCTAssertTrue(ReadGate.nextAnchored(false, unreadCount: 1, ready: true, firstUnread: nil, visibleMessageIds: []))
    }

    func testBannerStatesV2V4V7V16V17() {
        // V2: 2,000 unread, window not held: only 「既読にする」.
        let v2 = channel(lastSeq: 3000, lastRead: 1000, unread: 2000, oldest: 2951)
        XCTAssertEqual(ReadGate.banner(v2, focused: false, positioned: true, anchored: false, held: false, jumping: false, status: .online, now: now, calendar: calendar),
                       ReadGate.Banner(text: "未読 2,000 件 · 10:23 以降", jump: false, loading: false, enabled: true))
        XCTAssertNil(ReadGate.banner(v2, focused: false, positioned: false, anchored: false, held: false, jumping: false, status: .online)) // not placed yet
        // V4: 300 unread: both buttons; 「読み込み中…」 while loading.
        let v4 = channel(lastSeq: 1300, lastRead: 1000, unread: 300, oldest: 1251)
        XCTAssertEqual(ReadGate.banner(v4, focused: false, positioned: true, anchored: false, held: false, jumping: false, status: .online, now: now, calendar: calendar),
                       ReadGate.Banner(text: "未読 300 件 · 10:23 以降", jump: true, loading: false, enabled: true))
        XCTAssertEqual(ReadGate.banner(v4, focused: false, positioned: true, anchored: false, held: false, jumping: true, status: .online, now: now, calendar: calendar)?.loading, true)
        XCTAssertNil(ReadGate.banner(v4, focused: false, positioned: true, anchored: true, held: false, jumping: false, status: .online)) // after the jump
        // V16: offline: shown, both buttons disabled.
        XCTAssertEqual(ReadGate.banner(v4, focused: false, positioned: true, anchored: false, held: false, jumping: false, status: .offline)?.enabled, false)
        // V17: the search context has no banner; V13: neither does a held mark-as-unread.
        XCTAssertNil(ReadGate.banner(v4, focused: true, positioned: true, anchored: false, held: false, jumping: false, status: .online))
        XCTAssertNil(ReadGate.banner(v4, focused: false, positioned: true, anchored: false, held: true, jumping: false, status: .online))
        // V7: another device read up to 2990: 10 unread and the range is held, so the jump only scrolls.
        let v7 = channel(lastSeq: 3000, lastRead: 2990, unread: 10, oldest: 2951)
        XCTAssertEqual(ReadGate.banner(v7, focused: false, positioned: true, anchored: false, held: false, jumping: false, status: .online, now: now, calendar: calendar)?.jump, true)
        // V12: a set from elsewhere lowered the position below the window: the server's count, jump only up to 500.
        XCTAssertEqual(ReadGate.banner(channel(lastSeq: 1500, lastRead: 900, unread: 600, oldest: 1400, firstUnreadAt: nil), focused: false, positioned: true,
                                       anchored: false, held: false, jumping: false, status: .online), ReadGate.Banner(text: "未読 600 件", jump: false, loading: false, enabled: true))
        // V3 / V14: nothing unread, no banner.
        XCTAssertNil(ReadGate.banner(channel(lastSeq: 3000, lastRead: 3000, unread: 0, oldest: 2951, firstUnreadAt: nil), focused: false, positioned: true,
                                     anchored: false, held: false, jumping: false, status: .online))
    }

    /// §10.1 4. / 6. and §10.3: where a channel opens, with real-shaped rows (client_msg_id != id).
    func testOpenTargetV1V2V4V17() {
        let v1 = (81...130).map { row($0) }
        XCTAssertNotEqual(v1[20].rowKey, v1[20].id)
        XCTAssertEqual(ReadGate.openTarget(v1, focusId: nil, mark: ReadGate.dividerMark(held: nil, captured: 100, oldestLoadedSeq: 81), meId: "bob"),
                       .top(v1[20].rowKey)) // row 101 at the top
        XCTAssertEqual(shape(Timeline.build(v1, firstUnreadAfterSeq: 100, meId: "bob")).firstIndex(of: "unread"), 20)
        XCTAssertEqual(v1.filter { ($0.seq ?? 0) > 100 && $0.senderId != "bob" }.count, 30) // §10.1 7.: 「新着 30 件」 above the bottom

        // V2: no divider, the newest row.
        let v2 = (2951...3000).map { row($0) }
        let mark = ReadGate.dividerMark(held: nil, captured: 1000, oldestLoadedSeq: 2951)
        XCTAssertEqual(ReadGate.openTarget(v2, focusId: nil, mark: mark, meId: "bob"), .bottom)
        XCTAssertFalse(shape(Timeline.build(v2, firstUnreadAfterSeq: mark, meId: "bob")).contains("unread"))

        // V4 after the jump: my own rows are skipped, as the divider skips them.
        var v4 = (851...1300).map { row($0) }
        v4[150] = row(1001, sender: "bob")
        XCTAssertEqual(ReadGate.openTarget(v4, focusId: nil, mark: 1000, meId: "bob"), .top(v4[151].rowKey))

        // V17: a search hit is centred by its row key, found through the message.
        XCTAssertEqual(ReadGate.openTarget(v4, focusId: "id-1100", mark: 1000, meId: "bob"), .center("cmid-1100"))
    }

    /// §10.2: a thread never read (no follow row, last_read_seq 0) opens at the first reply from someone else.
    func testAThreadNeverReadOpensAtTheFirstReplyFromSomeoneElse() {
        let replies = [row(501, sender: "bob")] + (502...530).map { row($0) }
        XCTAssertEqual(ReadGate.threadTarget(replies, focusId: nil, lastReadSeq: 0, meId: "bob"), .top("cmid-502"))
    }

    /// §10.2 / V24 / V26: a ready thread opens at its first unread reply, or at the bottom.
    func testThreadTargetV24V26() {
        let replies = (501...530).map { row($0) }
        XCTAssertEqual(ReadGate.threadTarget(replies, focusId: nil, lastReadSeq: 510, meId: "bob"), .top("cmid-511"))
        XCTAssertEqual(ReadGate.threadTarget(replies, focusId: nil, lastReadSeq: 530, meId: "bob"), .bottom)
        XCTAssertEqual(ReadGate.threadTarget(replies, focusId: "id-520", lastReadSeq: 510, meId: "bob"), .center("cmid-520"))
        // The anchor is found through the message: the visible frames are keyed by message id.
        let first = ReadGate.firstUnreadRow(replies, afterSeq: 510, meId: "bob")
        XCTAssertEqual(first?.id, "id-511")
        XCTAssertTrue(ReadGate.nextAnchored(false, unreadCount: 20, ready: true, firstUnread: first, visibleMessageIds: Set((511...518).map { "id-\($0)" })))
    }
}
