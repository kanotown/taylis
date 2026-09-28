import XCTest
@testable import ChikuwaChat

/// The order of events in an open channel or thread (§10.1 2. / §10.2): what the views feed ReadAnchor and which seq may
/// then be marked read. Rows are real-shaped (client_msg_id != id), and "on screen" is what the view's frames say.
final class ReadAnchorTests: XCTestCase {
    private func row(_ seq: Int, sender: String = "alice") -> MessageState {
        var message = MessageState(placeholderFor: "cmid-\(seq)", channelId: "c", senderId: sender, body: "m\(seq)", createdAt: "2026-09-28T01:00:00Z")
        message.id = "id-\(seq)"
        message.seq = seq
        message.updatedSeq = seq
        message.pending = false
        return message
    }

    private func rows(_ range: ClosedRange<Int>) -> [MessageState] { range.map { row($0) } }

    /// One look at a channel: `shown` rows fully visible, `partly` rows cut by an edge of the viewport.
    private func look(_ anchor: inout ReadAnchor, _ all: [MessageState], lastRead: Int, unread: Int, ready: Bool = true,
                      shown: ClosedRange<Int>?, partly: [Int] = []) -> Int? {
        let visible = shown.map { range in all.filter { range.contains($0.seq ?? 0) } } ?? []
        let onScreen = Set(visible.map(\.id) + partly.map { "id-\($0)" })
        return anchor.observe(unreadCount: unread, ready: ready, firstUnread: ReadGate.firstUnreadRow(all, afterSeq: lastRead, meId: "bob"),
                              visible: visible, onScreenIds: onScreen)
    }

    /// Review (high): 「最初の未読へ」 used to set the anchor before the scroll ran, and the old viewport (the newest rows)
    /// then marked the whole channel read. Nothing is judged while the landing is on its way.
    func testJumpJudgesOnlyWhereTheLandingEnded() throws {
        var anchor = ReadAnchor()
        let before = rows(1251...1300) // V4: opened at the bottom, not ready
        XCTAssertNil(look(&anchor, before, lastRead: 1000, unread: 300, ready: false, shown: 1290...1300))
        XCTAssertFalse(anchor.hidesBanner)

        let after = rows(851...1300) // the jump loaded back to 851: ready
        let first = try XCTUnwrap(ReadGate.firstUnreadRow(after, afterSeq: 1000, meId: "bob"))
        anchor.land(on: first)
        XCTAssertEqual(anchor.landing?.rowId, "id-1001")
        XCTAssertEqual(anchor.landing?.rowKey, "cmid-1001") // scrolled to by its list key (§10.3)
        XCTAssertTrue(anchor.hidesBanner) // hidden before the scroll: no layout jump, no flash
        // The banner going away resizes the list and reports the old frames: ignored.
        XCTAssertNil(look(&anchor, after, lastRead: 1000, unread: 300, shown: 1290...1300))
        XCTAssertFalse(anchor.anchored)

        // The landing ended on the row: reading down marks only what is on screen.
        anchor.landed()
        XCTAssertEqual(look(&anchor, after, lastRead: 1000, unread: 300, shown: 1001...1012), 1012)
        XCTAssertTrue(anchor.anchored)
        XCTAssertEqual(look(&anchor, after, lastRead: 1012, unread: 288, shown: 1008...1020, partly: [1007, 1021]), 1020)
    }

    func testALandingThatMissedLeavesTheBannerAndMarksNothing() {
        var anchor = ReadAnchor()
        let all = rows(851...1300)
        anchor.land(on: all[150])
        anchor.landed() // three scrolls, and the estimated heights still left row 1001 above the screen
        XCTAssertNil(look(&anchor, all, lastRead: 1000, unread: 300, shown: 1041...1046))
        XCTAssertFalse(anchor.hidesBanner) // 「最初の未読へ」 again, which now only scrolls
        // A second landing on the same row is a new one (the scroll task runs again).
        anchor.land(on: all[150])
        let previous = anchor.landing
        anchor.land(on: all[150])
        XCTAssertNotEqual(anchor.landing, previous)
    }

    func testOpeningAtTheDividerLandsFirst() {
        // V1: the divider's row goes to the top; no banner meanwhile, and marks start from what is shown there.
        var anchor = ReadAnchor()
        let all = rows(81...130)
        anchor.land(on: all[20])
        XCTAssertTrue(anchor.hidesBanner)
        XCTAssertNil(look(&anchor, all, lastRead: 100, unread: 30, shown: 120...130)) // frames from before the scroll
        anchor.landed()
        XCTAssertEqual(look(&anchor, all, lastRead: 100, unread: 30, shown: 101...115), 115)
    }

    /// Review (high): the window ended at the read position (the app was away, bootstrap raised last_seq). Nothing
    /// unread was held, so the view anchored; the catch-up then filled in 300 rows and the list followed the bottom.
    func testRowsFilledInBelowTheScreenAreNotSkipped() {
        var anchor = ReadAnchor()
        let before = rows(81...130)
        // Not ready while the window does not reach last_seq (ReadGate.readRangeReady): nothing to anchor on yet.
        XCTAssertNil(look(&anchor, before, lastRead: 130, unread: 300, ready: false, shown: 120...130))
        XCTAssertFalse(anchor.anchored)
        // Even had it anchored (the old rule), the list past row 131 without showing it does not mark.
        var old = ReadAnchor()
        XCTAssertEqual(look(&old, before, lastRead: 130, unread: 300, shown: 120...130), 130) // nothing past 130 held: anchored
        XCTAssertTrue(old.anchored)
        let after = rows(81...430)
        XCTAssertNil(look(&old, after, lastRead: 130, unread: 300, shown: 415...430))
        XCTAssertFalse(old.anchored)
        XCTAssertNil(look(&old, after, lastRead: 130, unread: 300, shown: 300...315)) // scrolled up, not far enough
        XCTAssertEqual(look(&old, after, lastRead: 130, unread: 300, shown: 131...140), 140) // 「最初の未読へ」 or by hand
    }

    /// Review (medium): rows that arrive while the reader is not looking (another app, the thread sheet, offline) and
    /// are carried past by the list following the bottom are not read when the reader looks again.
    func testRowsThatPassedWhileAwayAreNotRead() {
        var anchor = ReadAnchor()
        let before = rows(81...130)
        XCTAssertEqual(look(&anchor, before, lastRead: 100, unread: 30, shown: 101...130), 130)
        let after = rows(81...160)
        XCTAssertNil(look(&anchor, after, lastRead: 130, unread: 30, shown: nil)) // the sheet covers the list: no rows seen
        XCTAssertTrue(anchor.anchored)
        XCTAssertNil(look(&anchor, after, lastRead: 130, unread: 30, shown: 145...160)) // back: 131...144 went by unseen
        XCTAssertFalse(anchor.hidesBanner)
        // A few arrivals that are all on screen are fine to read.
        var near = ReadAnchor()
        XCTAssertEqual(look(&near, before, lastRead: 100, unread: 30, shown: 101...130), 130)
        XCTAssertEqual(look(&near, rows(81...133), lastRead: 130, unread: 3, shown: 118...133, partly: [117]), 133)
    }

    func testReadingDownQuicklyKeepsTheAnchor() {
        var anchor = ReadAnchor()
        let all = rows(81...200)
        XCTAssertEqual(look(&anchor, all, lastRead: 100, unread: 100, shown: 101...110), 110)
        // The next row was only cut by the bottom edge when the frames came; now it is cut by the top edge.
        XCTAssertEqual(look(&anchor, all, lastRead: 110, unread: 90, shown: 112...121, partly: [111, 122]), 121)
        XCTAssertTrue(anchor.anchored)
    }

    /// Review (medium) and V11: another device's 「ここから未読にする」 lowers the position below the screen; this device
    /// does not undo it with the rows it already shows, and marks again once the new first unread row is on screen.
    func testALoweredPositionHasToBeSeenAgain() {
        var anchor = ReadAnchor()
        let all = rows(81...1130)
        XCTAssertEqual(look(&anchor, all, lastRead: 1100, unread: 30, shown: 1101...1130), 1130)
        anchor.positionLowered() // read.updated (set) to 500
        XCTAssertNil(look(&anchor, all, lastRead: 500, unread: 630, shown: 1101...1130))
        XCTAssertFalse(anchor.hidesBanner)
        XCTAssertEqual(look(&anchor, all, lastRead: 500, unread: 630, shown: 501...512), 512)
        // Lowered to a row still on screen: marking resumes on the next look (never from the read state change itself,
        // which the view does not send).
        anchor.positionLowered()
        XCTAssertEqual(look(&anchor, all, lastRead: 1110, unread: 20, shown: 1101...1130), 1130)
    }

    /// Review (low): a held 「ここから未読にする」 cleared by a conversation opened in the search sheet; the reader had
    /// scrolled past the held row meanwhile.
    func testAHoldEndedElsewhereNeedsTheHeldRowAgain() {
        var anchor = ReadAnchor()
        let all = rows(81...130)
        XCTAssertEqual(look(&anchor, all, lastRead: 100, unread: 30, shown: 101...115), 115)
        anchor.positionLowered() // markUnread on row 110: position 109
        _ = look(&anchor, all, lastRead: 109, unread: 21, shown: 115...130) // (the engine ignores marks while held)
        anchor.positionLowered() // the hold went away without a read
        XCTAssertNil(look(&anchor, all, lastRead: 109, unread: 21, shown: 115...130))
        XCTAssertEqual(look(&anchor, all, lastRead: 109, unread: 21, shown: 105...120), 120)
    }

    func testNothingUnreadAnchorsAtOnce() {
        var anchor = ReadAnchor()
        let all = rows(101...160)
        // V14: rows that are not counted as unread (system rows) never block reading, wherever the list is.
        XCTAssertEqual(look(&anchor, all, lastRead: 100, unread: 0, ready: false, shown: 150...160), 160)
        // V3: 「既読にする」 makes the count 0: anchored, the banner goes.
        var forced = ReadAnchor()
        XCTAssertNil(look(&forced, rows(2951...3000), lastRead: 1000, unread: 2000, ready: false, shown: 2990...3000))
        XCTAssertEqual(look(&forced, rows(2951...3000), lastRead: 3000, unread: 0, shown: 2990...3000), 3000)
        XCTAssertTrue(forced.hidesBanner)
    }

    func testResetOnOpenAndFocusChange() {
        var anchor = ReadAnchor()
        let all = rows(81...130)
        _ = look(&anchor, all, lastRead: 100, unread: 30, shown: 101...130)
        anchor.land(on: all[0])
        anchor.reset()
        XCTAssertFalse(anchor.anchored)
        XCTAssertNil(anchor.landing)
    }

    /// §10.2: a thread (no unread count) anchors only once complete, and then like a channel.
    func testThreadAnchorV24V26() throws {
        var anchor = ReadAnchor()
        let replies = rows(501...530)
        let first = ReadGate.firstUnreadRow(replies, afterSeq: 510, meId: "bob")
        func look(_ ready: Bool, _ shown: ClosedRange<Int>, lastRead: Int = 510, partly: [Int] = []) -> Int? {
            let visible = replies.filter { shown.contains($0.seq ?? 0) }
            return anchor.observe(unreadCount: nil, ready: ready, firstUnread: ready ? ReadGate.firstUnreadRow(replies, afterSeq: lastRead, meId: "bob") : nil,
                                  visible: visible, onScreenIds: Set(visible.map(\.id) + partly.map { "id-\($0)" }))
        }
        XCTAssertNil(look(false, 529...530)) // V24: only the live r29, r30 held so far
        XCTAssertFalse(anchor.anchored)
        anchor.land(on: try XCTUnwrap(first))
        XCTAssertNil(look(true, 529...530))
        anchor.landed()
        XCTAssertEqual(look(true, 511...518), 518)
        XCTAssertNil(look(false, 511...518)) // V25: a reload dropped the replies
        XCTAssertFalse(anchor.anchored)
        // V26: nothing unread: anchored at the bottom at once.
        var read = ReadAnchor()
        XCTAssertEqual(read.observe(unreadCount: nil, ready: true, firstUnread: ReadGate.firstUnreadRow(replies, afterSeq: 530, meId: "bob"),
                                    visible: Array(replies.suffix(8)), onScreenIds: Set(replies.suffix(8).map(\.id))), 530)
        // Replies that arrived while the sheet was in the background and went by unseen.
        var away = ReadAnchor()
        XCTAssertEqual(away.observe(unreadCount: nil, ready: true, firstUnread: nil, visible: Array(replies.suffix(5)), onScreenIds: Set(replies.suffix(5).map(\.id))), 530)
        let more = rows(501...560)
        let next = ReadGate.firstUnreadRow(more, afterSeq: 530, meId: "bob")
        XCTAssertNil(away.observe(unreadCount: nil, ready: true, firstUnread: next, visible: Array(more.suffix(5)), onScreenIds: Set(more.suffix(5).map(\.id))))
        XCTAssertFalse(away.anchored)
    }

    /// V36 / §10.1 2.-3: the reader went up (495...510 on screen) while anchored at 1100, and another device set the
    /// position to 500. The view lowers the anchor and does not send from that evaluation (ChannelView's
    /// `markRead(send: false)`), although row 501 is on screen; the next scroll marks what is shown.
    func testV36ASetBelowTheScreenIsNotUndoneByTheSameLook() {
        var anchor = ReadAnchor()
        let all = rows(81...1130)
        XCTAssertEqual(look(&anchor, all, lastRead: 1090, unread: 40, shown: 1091...1100), 1100)
        XCTAssertEqual(look(&anchor, all, lastRead: 1100, unread: 30, shown: 495...510), 510) // at or below the position: the engine ignores it
        XCTAssertTrue(anchor.anchored)
        anchor.positionLowered() // read.updated (set) 500
        XCTAssertFalse(anchor.anchored)
        _ = look(&anchor, all, lastRead: 500, unread: 630, shown: 495...510) // the evaluation of the change: not sent
        XCTAssertTrue(anchor.anchored) // row 501 is on screen
        XCTAssertEqual(look(&anchor, all, lastRead: 500, unread: 630, shown: 498...513), 513) // the next scroll
    }

    /// V45 / §10.1 2.-1: a §7.3 reload ran in the background (the range was empty while nobody looked). The first look
    /// back in the foreground finds the new page's first unread row above the screen: not anchored, nothing sent.
    func testV45AReloadWhileAwayIsJudgedOnTheFirstLookBack() {
        var anchor = ReadAnchor()
        XCTAssertEqual(look(&anchor, rows(81...130), lastRead: 130, unread: 0, shown: 116...130), 130)
        XCTAssertTrue(anchor.anchored)
        // Background: 6,000 arrived, the reload read 6081...6130 while no frame was reported; the position was 6100.
        let page = rows(6081...6130)
        XCTAssertNil(look(&anchor, page, lastRead: 6100, unread: 30, shown: 6116...6130))
        XCTAssertFalse(anchor.anchored)
        XCTAssertFalse(anchor.hidesBanner)
        XCTAssertEqual(look(&anchor, page, lastRead: 6100, unread: 30, shown: 6101...6112), 6112) // row 6101 on screen
    }

    /// V46 / §10.1 2.: the rows and the channel state are taken from the same moment. Right after the 5th page of V6
    /// (window 1001...), the first unread row is 1001, above the screen; the stale rows from before the page (1051...)
    /// would make 1051 look like the first unread row, on screen, and skip 1001...1050.
    func testV46RowsAndStateFromTheSameMoment() {
        let live = rows(1001...1300)
        let stale = rows(1051...1300)
        var anchor = ReadAnchor()
        XCTAssertNil(look(&anchor, live, lastRead: 1000, unread: 300, shown: 1051...1060))
        XCTAssertFalse(anchor.anchored)
        var wrong = ReadAnchor()
        XCTAssertEqual(look(&wrong, stale, lastRead: 1000, unread: 300, shown: 1051...1060), 1060) // what mixing would do
    }

    /// V51 / §10.2: a complete thread read to its bottom and anchored; a reconnect brings 10 replies taller than the
    /// screen and the list follows the bottom. The first unread reply went by unseen: no thread read.
    func testV51RepliesFollowedPastUnseenDropTheThreadAnchor() {
        var anchor = ReadAnchor()
        let before = rows(501...530)
        func look(_ replies: [MessageState], lastRead: Int, shown: ClosedRange<Int>) -> Int? {
            let visible = replies.filter { shown.contains($0.seq ?? 0) }
            return anchor.observe(unreadCount: nil, ready: true, firstUnread: ReadGate.firstUnreadRow(replies, afterSeq: lastRead, meId: "bob"),
                                  visible: visible, onScreenIds: Set(visible.map(\.id)))
        }
        XCTAssertEqual(look(before, lastRead: 510, shown: 511...530), 530)
        let after = rows(501...540)
        XCTAssertNil(look(after, lastRead: 530, shown: 536...540))
        XCTAssertFalse(anchor.anchored)
        XCTAssertEqual(look(after, lastRead: 530, shown: 531...535), 535) // scrolled back to reply 531
    }

    func testPassedUnseen() {
        let first = row(131)
        XCTAssertTrue(ReadGate.passedUnseen(first, visibleSeqs: [415, 430], onScreenIds: ["id-415"]))
        XCTAssertFalse(ReadGate.passedUnseen(first, visibleSeqs: [132, 140], onScreenIds: ["id-131"])) // cut by the top edge
        XCTAssertFalse(ReadGate.passedUnseen(first, visibleSeqs: [120, 130], onScreenIds: [])) // still below
        XCTAssertFalse(ReadGate.passedUnseen(first, visibleSeqs: [], onScreenIds: [])) // nothing seen: nothing to judge
        XCTAssertFalse(ReadGate.passedUnseen(nil, visibleSeqs: [415], onScreenIds: []))
        // Matched by message id, never by the row key (§10.3).
        XCTAssertTrue(ReadGate.passedUnseen(first, visibleSeqs: [415], onScreenIds: [first.rowKey]))
    }
}
