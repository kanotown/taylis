import XCTest
@testable import ChikuwaChat

final class TimelineTests: XCTestCase {
    private var calendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Asia/Tokyo")!
        return calendar
    }()
    private let now = parseIsoDate("2026-09-26T03:00:00Z")! // 12:00 JST

    private func message(_ id: String, sender: String, at: String, seq: Int) -> MessageState {
        var message = MessageState(placeholderFor: id, channelId: "c", senderId: sender, body: id, createdAt: at)
        message.id = id
        message.seq = seq
        message.updatedSeq = seq
        message.pending = false
        message.clientMsgId = nil
        return message
    }

    func testDayLabelsAreRelativeToToday() {
        XCTAssertEqual(Timeline.dayLabel(parseIsoDate("2026-09-26T00:00:00Z")!, now: now, calendar: calendar), "今日")
        XCTAssertEqual(Timeline.dayLabel(parseIsoDate("2026-09-25T14:00:00Z")!, now: now, calendar: calendar), "昨日")
        XCTAssertEqual(Timeline.dayLabel(parseIsoDate("2026-09-01T00:00:00Z")!, now: now, calendar: calendar), "9月1日 (火)")
        XCTAssertEqual(Timeline.dayLabel(parseIsoDate("2025-12-31T00:00:00Z")!, now: now, calendar: calendar), "2025年12月31日 (水)")
    }

    func testGroupsConsecutiveMessagesAndPlacesUnreadDividerOnce() {
        let items = Timeline.build(
            [
                message("a", sender: "u1", at: "2026-09-25T01:00:00Z", seq: 1),
                message("b", sender: "u1", at: "2026-09-25T01:02:00Z", seq: 2),
                message("c", sender: "u1", at: "2026-09-25T01:20:00Z", seq: 3),
                message("d", sender: "u2", at: "2026-09-26T00:00:00Z", seq: 4),
                message("e", sender: "u2", at: "2026-09-26T00:01:00Z", seq: 5),
            ],
            firstUnreadAfterSeq: 3, meId: "me", grouping: true, now: now, calendar: calendar
        )
        let shape = items.map { item -> String in
            switch item {
            case .date: return "date"
            case .unread: return "unread"
            case .message(let message, let compact): return message.id + (compact ? "*" : "")
            }
        }
        XCTAssertEqual(shape, ["date", "a", "b*", "c", "date", "unread", "d", "e*"])
    }

    /// M47: 「連続した投稿をまとめる」 off (the default) gives every post its header; the separators stay where they were.
    func testGroupingOffGivesEveryPostItsHeader() {
        let rows = [
            message("a", sender: "u1", at: "2026-09-25T01:00:00Z", seq: 1),
            message("b", sender: "u1", at: "2026-09-25T01:02:00Z", seq: 2),
            message("d", sender: "u2", at: "2026-09-26T00:00:00Z", seq: 4),
            message("e", sender: "u2", at: "2026-09-26T00:01:00Z", seq: 5),
        ]
        let shape = { (grouping: Bool) in
            Timeline.build(rows, firstUnreadAfterSeq: 4, meId: "me", grouping: grouping, now: self.now, calendar: self.calendar).map { item -> String in
                switch item {
                case .date: return "date"
                case .unread: return "unread"
                case .message(let message, let compact): return message.id + (compact ? "*" : "")
                }
            }
        }
        XCTAssertEqual(shape(false), ["date", "a", "b", "date", "d", "unread", "e"])
        XCTAssertEqual(shape(true), ["date", "a", "b*", "date", "d", "unread", "e"])
    }

    /// M47: a thread's replies group by the channel's rule when on: the same sender within the window, cut by a new day
    /// and by the 「新しい返信」 divider; the first reply keeps its header. Off, none groups.
    func testThreadRepliesGroupOnlyWhenOn() {
        var replies = [
            message("r1", sender: "u1", at: "2026-09-25T01:00:00Z", seq: 1),
            message("r2", sender: "u1", at: "2026-09-25T01:02:00Z", seq: 2),
            message("r3", sender: "u1", at: "2026-09-25T01:20:00Z", seq: 3), // past the window
            message("r4", sender: "u2", at: "2026-09-25T01:21:00Z", seq: 4),
            message("r5", sender: "u2", at: "2026-09-25T01:22:00Z", seq: 5), // after the divider
            message("r6", sender: "u2", at: "2026-09-25T14:58:00Z", seq: 6), // 23:58 JST
            message("r7", sender: "u2", at: "2026-09-25T15:01:00Z", seq: 7), // 00:01 JST the next day
            message("r8", sender: "u2", at: "2026-09-25T15:02:00Z", seq: 8),
        ]
        for index in replies.indices { replies[index].parentId = "p" }
        XCTAssertEqual(Timeline.threadCompactIds(replies, firstUnreadId: "r5", grouping: true, now: now, calendar: calendar), ["r2", "r8"])
        XCTAssertEqual(Timeline.threadCompactIds(replies, firstUnreadId: nil, grouping: true, now: now, calendar: calendar), ["r2", "r5", "r8"])
        XCTAssertEqual(Timeline.threadCompactIds(replies, firstUnreadId: nil, grouping: false, now: now, calendar: calendar), [])
    }

    func testInitialsAndHueAreStable() {
        XCTAssertEqual(Timeline.initials("Toru Kano"), "TK")
        XCTAssertEqual(Timeline.initials("かのう"), "か")
        XCTAssertEqual(Timeline.initials("  "), "?")
        XCTAssertEqual(Timeline.hue("user-1"), Timeline.hue("user-1"))
        XCTAssertNil(Timeline.muteLabel("2020-01-01T00:00:00Z", now: now))
        XCTAssertNotNil(Timeline.muteLabel("2026-09-26T10:00:00Z", now: now))
    }

    /// The reactions wrap into lines as wide as the row instead of running past the screen's edge.
    func testChipsGoOnTheNextLineWhenTheyDoNotFit() {
        let chip = CGSize(width: 40, height: 22), plus = CGSize(width: 44, height: 22)
        let frames = ChipsLayout.frames(Array(repeating: chip, count: 7) + [plus], width: 200, spacing: 6)
        XCTAssertEqual(frames.map(\.minX), [0, 46, 92, 138, 0, 46, 92, 138])
        XCTAssertEqual(frames.map(\.minY), [0, 0, 0, 0, 28, 28, 28, 28])
        XCTAssertLessThanOrEqual(frames.map(\.maxX).max() ?? 0, 200)
        // Few enough for one line: one line, as before.
        XCTAssertEqual(ChipsLayout.frames([chip, chip, plus], width: 200, spacing: 6).map(\.minY), [0, 0, 0])
        // A chip wider than the row still gets a line of its own.
        XCTAssertEqual(ChipsLayout.frames([chip, CGSize(width: 260, height: 22)], width: 200, spacing: 6).map(\.minY), [0, 28])
    }
}
